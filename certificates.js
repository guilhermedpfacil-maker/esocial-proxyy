/**
 * Módulo de gerenciamento de certificados digitais por empresa
 * Armazena certificados PFX em memória com persistência em disco
 */

const fs = require('fs');
const path = require('path');

const STORE_PATH = process.env.CERT_STORE_PATH || path.join(__dirname, 'certificates.json');

// Armazenamento em memória indexado por CNPJ (somente dígitos)
const store = new Map();

function loadFromDisk() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      for (const [cnpj, cert] of Object.entries(data)) {
        store.set(cnpj, cert);
      }
      console.log(`[Certificates] ${store.size} certificado(s) carregado(s) do disco`);
    }
  } catch (err) {
    console.error('[Certificates] Erro ao carregar do disco:', err.message);
  }
}

function saveToDisk() {
  try {
    const data = Object.fromEntries(store);
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[Certificates] Erro ao salvar no disco:', err.message);
  }
}

/**
 * Adiciona ou atualiza o certificado de uma empresa
 */
function addCertificate({ cnpj, nome, certificatePfx, password }) {
  const cnpjClean = cnpj.replace(/\D/g, '');
  if (cnpjClean.length !== 14) {
    throw new Error('CNPJ inválido: deve conter 14 dígitos');
  }

  const existing = store.get(cnpjClean);
  store.set(cnpjClean, {
    cnpj: cnpjClean,
    nome: nome || cnpjClean,
    certificatePfx,
    password,
    addedAt: existing?.addedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  saveToDisk();
  return getSafeInfo(cnpjClean);
}

/**
 * Retorna o certificado completo de uma empresa (com PFX e senha)
 */
function getCertificate(cnpj) {
  const cnpjClean = cnpj.replace(/\D/g, '');
  return store.get(cnpjClean) || null;
}

/**
 * Lista todas as empresas (sem dados sensíveis)
 */
function listCertificates() {
  return Array.from(store.values()).map(({ cnpj, nome, addedAt, updatedAt }) => ({
    cnpj,
    nome,
    addedAt,
    updatedAt
  }));
}

/**
 * Remove o certificado de uma empresa
 */
function deleteCertificate(cnpj) {
  const cnpjClean = cnpj.replace(/\D/g, '');
  const existed = store.has(cnpjClean);
  if (existed) {
    store.delete(cnpjClean);
    saveToDisk();
  }
  return existed;
}

function getSafeInfo(cnpjClean) {
  const cert = store.get(cnpjClean);
  if (!cert) return null;
  const { cnpj, nome, addedAt, updatedAt } = cert;
  return { cnpj, nome, addedAt, updatedAt };
}

// Converte PFX (base64) para PEM usando node-forge
function pfxToPem(pfxBase64, password) {
  const forge = require('node-forge');
  const pfxDer = forge.util.decode64(pfxBase64);
  const pfxAsn1 = forge.asn1.fromDer(pfxDer);
  const pfx = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, false, password);

  const keyBags = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const certBags = pfx.getBags({ bagType: forge.pki.oids.certBag });

  const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
  const certBag = certBags[forge.pki.oids.certBag]?.[0];

  if (!keyBag || !certBag) {
    throw new Error('Certificado PFX inválido: não foi possível extrair chave ou certificado');
  }

  return {
    privateKeyPem: forge.pki.privateKeyToPem(keyBag.key),
    certificatePem: forge.pki.certificateToPem(certBag.cert)
  };
}

loadFromDisk();

module.exports = {
  addCertificate,
  getCertificate,
  listCertificates,
  deleteCertificate,
  pfxToPem
};
