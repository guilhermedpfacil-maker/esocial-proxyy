/**
 * Cliente dos Webservices SOAP do eSocial (mTLS + assinatura XML)
 *
 * Substitui o web scraping (bloqueado por hCaptcha) por chamadas diretas
 * aos webservices oficiais do eSocial, usando o certificado digital A1 (PFX)
 * da empresa via mTLS e assinatura XMLDSig (enveloped, SHA-256).
 *
 * Fluxo para obter o XML do evento S-5002 (IRRF por trabalhador):
 *  1. ConsultarIdentificadoresEventosEmpregador(tpEvt='S-5002', perApur)
 *     -> retorna os Ids dos eventos S-5002 disponíveis para o período
 *  2. SolicitarDownloadEventosPorId(ids)
 *     -> retorna o XML completo (evtIrrfBenef) de cada evento
 *  3. Filtra os XMLs pelo CPF do beneficiário (cpfBenef)
 */

const https = require('https');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');

const HOST_IDENTIFICADORES = 'webservices.download.esocial.gov.br';
const PATH_IDENTIFICADORES = '/servicos/empregador/dwlcirurgico/WsConsultarIdentificadoresEventos.svc';
const HOST_DOWNLOAD = 'webservices.download.esocial.gov.br';
const PATH_DOWNLOAD = '/servicos/empregador/dwlcirurgico/WsSolicitarDownloadEventos.svc';

const NS_IDENTIFICADORES = 'http://www.esocial.gov.br/servicos/empregador/consulta/identificadores-eventos/v1_0_0';
const NS_DOWNLOAD = 'http://www.esocial.gov.br/servicos/empregador/download/solicitacao/v1_0_0';

/**
 * Extrai chave privada (PEM) e certificado (PEM) de um buffer PFX/PKCS#12
 */
function extractKeyAndCert(pfxBuffer, passphrase) {
  const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer.toString('binary')));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, passphrase);

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });

  const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
  const certBag = certBags[forge.pki.oids.certBag]?.[0];

  if (!keyBag || !certBag) {
    throw new Error('Não foi possível extrair chave privada ou certificado do PFX');
  }

  return {
    privateKeyPem: forge.pki.privateKeyToPem(keyBag.key),
    certificatePem: forge.pki.certificateToPem(certBag.cert),
  };
}

/**
 * Assina um XML do eSocial (elemento raiz <eSocial>) com assinatura
 * XMLDSig enveloped, C14N, SHA-256, conforme padrão exigido pelos
 * webservices do eSocial.
 */
function signEsocialXml(xml, privateKeyPem, certificatePem) {
  const sig = new SignedXml({
    privateKey: privateKeyPem,
    publicCert: certificatePem,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  });

  sig.addReference({
    xpath: "//*[local-name(.)='eSocial']",
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    isEmptyUri: true,
  });

  sig.getKeyInfoContent = ({ publicCert }) => {
    const der = publicCert.toString()
      .replace(/-----BEGIN CERTIFICATE-----/, '')
      .replace(/-----END CERTIFICATE-----/, '')
      .replace(/[\r\n]/g, '');
    return `<X509Data><X509Certificate>${der}</X509Certificate></X509Data>`;
  };

  sig.computeSignature(xml, {
    location: { reference: "//*[local-name(.)='eSocial']", action: 'append' },
  });

  return sig.getSignedXml();
}

/**
 * Faz uma requisição SOAP via mTLS (certificado do cliente) para os
 * webservices do eSocial.
 */
function soapRequest(hostname, path, soapAction, envelopeXml, pfxBuffer, passphrase) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(envelopeXml, 'utf8');

    const req = https.request({
      hostname,
      port: 443,
      path,
      method: 'POST',
      pfx: pfxBuffer,
      passphrase,
      rejectUnauthorized: true,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': `"${soapAction}"`,
        'Content-Length': body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(45000, () => {
      req.destroy();
      reject(new Error('Timeout na requisição ao webservice do eSocial (45s)'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Verifica se a resposta SOAP contém um Fault e retorna a mensagem, ou null.
 */
function extractSoapFault(xml) {
  const m = xml.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
  if (m) return m[1].trim();
  const m2 = xml.match(/<descResposta>([\s\S]*?)<\/descResposta>/i);
  const c2 = xml.match(/<cdResposta>([\s\S]*?)<\/cdResposta>/i);
  if (m2 && c2 && c2[1].trim() !== '0' && c2[1].trim() !== '201') {
    return `[${c2[1].trim()}] ${m2[1].trim()}`;
  }
  return null;
}

/**
 * 1) ConsultarIdentificadoresEventosEmpregador
 * Retorna a lista de Ids de eventos do tipo tpEvt para o período perApur.
 */
async function consultarIdentificadoresEventosEmpregador({ tpInsc, nrInsc, tpEvt, perApur, pfxBuffer, passphrase, privateKeyPem, certificatePem }) {
  const inner = `<eSocial xmlns="http://www.esocial.gov.br/schema/consulta/identificadores-eventos/empregador/v1_0_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<consultaIdentificadoresEvts>` +
    `<ideEmpregador><tpInsc>${tpInsc}</tpInsc><nrInsc>${nrInsc}</nrInsc></ideEmpregador>` +
    `<consultaEvtsEmpregador><tpEvt>${tpEvt}</tpEvt><perApur>${perApur}</perApur></consultaEvtsEmpregador>` +
    `</consultaIdentificadoresEvts>` +
    `</eSocial>`;

  const signed = signEsocialXml(inner, privateKeyPem, certificatePem);

  const envelope = `<?xml version="1.0" encoding="utf-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v1="${NS_IDENTIFICADORES}">` +
    `<soapenv:Header/>` +
    `<soapenv:Body>` +
    `<v1:ConsultarIdentificadoresEventosEmpregador>` +
    `<v1:consultaEventosEmpregador>${signed}</v1:consultaEventosEmpregador>` +
    `</v1:ConsultarIdentificadoresEventosEmpregador>` +
    `</soapenv:Body>` +
    `</soapenv:Envelope>`;

  const soapAction = `${NS_IDENTIFICADORES}/ServicoConsultarIdentificadoresEventos/ConsultarIdentificadoresEventosEmpregador`;

  const res = await soapRequest(HOST_IDENTIFICADORES, PATH_IDENTIFICADORES, soapAction, envelope, pfxBuffer, passphrase);

  const fault = extractSoapFault(res.body);
  if (fault) {
    return { success: false, statusCode: res.statusCode, error: fault, raw: res.body, ids: [] };
  }

  // Extrai todos os Ids de eventos retornados (formato típico: ID1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx)
  const ids = [...res.body.matchAll(/Id="(ID[A-Za-z0-9]+)"/g)].map((m) => m[1]);
  // fallback: <id>...</id>
  if (ids.length === 0) {
    const idsAlt = [...res.body.matchAll(/<id>([A-Za-z0-9]+)<\/id>/g)].map((m) => m[1]);
    ids.push(...idsAlt);
  }

  return { success: true, statusCode: res.statusCode, ids: [...new Set(ids)], raw: res.body };
}

/**
 * 2) SolicitarDownloadEventosPorId
 * Retorna o XML completo de cada evento solicitado.
 */
async function solicitarDownloadEventosPorId({ tpInsc, nrInsc, ids, pfxBuffer, passphrase, privateKeyPem, certificatePem }) {
  const idsXml = ids.map((id) => `<id>${id}</id>`).join('');

  const inner = `<eSocial xmlns="http://www.esocial.gov.br/schema/download/solicitacao/id/v1_0_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<download>` +
    `<ideEmpregador><tpInsc>${tpInsc}</tpInsc><nrInsc>${nrInsc}</nrInsc></ideEmpregador>` +
    `<solicDownloadEvtsPorId>${idsXml}</solicDownloadEvtsPorId>` +
    `</download>` +
    `</eSocial>`;

  const signed = signEsocialXml(inner, privateKeyPem, certificatePem);

  const envelope = `<?xml version="1.0" encoding="utf-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v1="${NS_DOWNLOAD}">` +
    `<soapenv:Header/>` +
    `<soapenv:Body>` +
    `<v1:SolicitarDownloadEventosPorId>` +
    `<v1:solicitacao>${signed}</v1:solicitacao>` +
    `</v1:SolicitarDownloadEventosPorId>` +
    `</soapenv:Body>` +
    `</soapenv:Envelope>`;

  const soapAction = `${NS_DOWNLOAD}/ServicoSolicitarDownloadEventos/SolicitarDownloadEventosPorId`;

  const res = await soapRequest(HOST_DOWNLOAD, PATH_DOWNLOAD, soapAction, envelope, pfxBuffer, passphrase);

  const fault = extractSoapFault(res.body);
  if (fault) {
    return { success: false, statusCode: res.statusCode, error: fault, raw: res.body, eventos: [] };
  }

  // Cada evento retornado vem como um documento <eSocial ...>...<evtIrrfBenef Id="...">...</evtIrrfBenef>...</eSocial>
  // embutido no corpo da resposta SOAP.
  const eventos = [...res.body.matchAll(/<eSocial[^>]*>[\s\S]*?<\/eSocial>/g)].map((m) => m[0]);

  return { success: true, statusCode: res.statusCode, eventos, raw: res.body };
}

/**
 * Extrai o CPF do beneficiário (cpfBenef) de um XML de evento evtIrrfBenef (S-5002).
 */
function extractCpfBenef(eventoXml) {
  const m = eventoXml.match(/<cpfBenef>(\d+)<\/cpfBenef>/);
  return m ? m[1] : null;
}

/**
 * Fluxo completo: para um período (perApur), busca os eventos S-5002 da
 * empresa e retorna o XML de cada CPF solicitado que for encontrado.
 *
 * @returns {Promise<{ perApur, success, error?, raw?, encontrados: Array<{cpf, xml}> }>}
 */
async function getIrrfXmlsForPeriod({ cnpj, perApur, cpfs, pfxBuffer, passphrase }) {
  const { privateKeyPem, certificatePem } = extractKeyAndCert(pfxBuffer, passphrase);
  const nrInsc = cnpj.replace(/\D/g, '').substring(0, 8); // raiz do CNPJ (8 dígitos)
  const tpInsc = '1'; // 1 = CNPJ

  const ctx = { tpInsc, nrInsc, pfxBuffer, passphrase, privateKeyPem, certificatePem };

  const idsResult = await consultarIdentificadoresEventosEmpregador({ ...ctx, tpEvt: 'S-5002', perApur });
  if (!idsResult.success) {
    return { perApur, success: false, error: idsResult.error, raw: idsResult.raw, encontrados: [] };
  }

  if (idsResult.ids.length === 0) {
    return { perApur, success: true, encontrados: [], raw: idsResult.raw, info: 'Nenhum evento S-5002 encontrado para o período' };
  }

  // SolicitarDownloadEventosPorId aceita um número limitado de Ids por chamada (até 50)
  const BATCH_SIZE = 50;
  const cpfsSet = new Set(cpfs.map((c) => c.replace(/\D/g, '')));
  const encontrados = [];
  let lastRaw = idsResult.raw;

  for (let i = 0; i < idsResult.ids.length; i += BATCH_SIZE) {
    const batch = idsResult.ids.slice(i, i + BATCH_SIZE);
    const downloadResult = await solicitarDownloadEventosPorId({ ...ctx, ids: batch });
    lastRaw = downloadResult.raw;

    if (!downloadResult.success) {
      return { perApur, success: false, error: downloadResult.error, raw: downloadResult.raw, encontrados };
    }

    for (const eventoXml of downloadResult.eventos) {
      const cpf = extractCpfBenef(eventoXml);
      if (cpf && cpfsSet.has(cpf)) {
        encontrados.push({ cpf, xml: eventoXml });
      }
    }
  }

  return { perApur, success: true, encontrados, raw: lastRaw, totalEventos: idsResult.ids.length };
}

module.exports = {
  extractKeyAndCert,
  signEsocialXml,
  soapRequest,
  consultarIdentificadoresEventosEmpregador,
  solicitarDownloadEventosPorId,
  extractCpfBenef,
  getIrrfXmlsForPeriod,
};
