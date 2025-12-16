/**
 * eSocial Proxy Server
 * Proxy Node.js para comunicação mTLS com o portal eSocial.
 */

const express = require('express');
const https = require('https');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS - permitir chamadas do Lovable
const allowedOrigins = [
  /\.lovable\.app$/,
  /\.lovableproject\.com$/,
  /localhost:\d+$/,
  /127\.0\.0\.1:\d+$/
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const isAllowed = allowedOrigins.some(pattern => 
      pattern instanceof RegExp ? pattern.test(origin) : origin === pattern
    );
    callback(null, isAllowed);
  },
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// Rate limiting simples
const requestCounts = new Map();
const RATE_LIMIT = 100;
const RATE_WINDOW = 60000;

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowStart = now - RATE_WINDOW;
  
  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, []);
  }
  
  const requests = requestCounts.get(ip).filter(time => time > windowStart);
  
  if (requests.length >= RATE_LIMIT) {
    return res.status(429).json({ 
      success: false, 
      error: 'Rate limit exceeded. Tente novamente em 1 minuto.' 
    });
  }
  
  requests.push(now);
  requestCounts.set(ip, requests);
  next();
}

// URLs do eSocial
const ESOCIAL_URLS = {
  'producao': {
    hostname: 'webservices.esocial.gov.br',
    consulta: '/servicos/empregador/consultarloteeventos/WsConsultarLoteEventos.svc',
    download: '/servicos/empregador/download/WsDownload.svc'
  },
  'producao-restrita': {
    hostname: 'webservices.producaorestrita.esocial.gov.br',
    consulta: '/servicos/empregador/consultarloteeventos/WsConsultarLoteEventos.svc',
    download: '/servicos/empregador/download/WsDownload.svc'
  }
};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
// Endpoint principal - chamadas ao eSocial
app.post('/api/esocial', rateLimit, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { 
      action, 
      ambiente, 
      privateKeyPem, 
      certificatePem, 
      tpInsc, 
      nrInsc, 
      perApur, 
      tpEvento 
    } = req.body;

    if (!privateKeyPem || !certificatePem) {
      return res.status(400).json({ 
        success: false, 
        error: 'Certificado digital (privateKeyPem e certificatePem) é obrigatório' 
      });
    }

    if (!ambiente || !['producao', 'producao-restrita'].includes(ambiente)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Ambiente inválido. Use: producao ou producao-restrita' 
      });
    }

    if (!tpInsc || !nrInsc) {
      return res.status(400).json({ 
        success: false, 
        error: 'tpInsc e nrInsc são obrigatórios' 
      });
    }

    const requestAction = action || 'download';
    const periodo = perApur || getCurrentPeriod();
    const eventoTipo = tpEvento || 'S-5002';

    console.log('[eSocial Proxy] Request:', requestAction, 'Ambiente:', ambiente, 'CNPJ:', nrInsc, 'Período:', periodo);

    const esocialConfig = ESOCIAL_URLS[ambiente];
    const path = requestAction === 'consultar' ? esocialConfig.consulta : esocialConfig.download;
    
    const soapBody = buildSoapEnvelope(requestAction, tpInsc, nrInsc, periodo, eventoTipo);

    const soapAction = requestAction === 'consultar'
      ? 'http://www.esocial.gov.br/servicos/empregador/consulta/retornoProcessamento/v1_0_0/ServicoConsultarLoteEventos/ConsultarLoteEventos'
      : 'http://www.esocial.gov.br/servicos/empregador/download/v1_0_0/ServicoDownload/Download';

    const options = {
      hostname: esocialConfig.hostname,
      port: 443,
      path: path,
      method: 'POST',
      key: privateKeyPem,
      cert: certificatePem,
      rejectUnauthorized: true,
      headers: {
        'Content-Type': 'application/soap+xml;charset=UTF-8',
        'Content-Length': Buffer.byteLength(soapBody, 'utf8'),
        'SOAPAction': soapAction
      },
      timeout: 30000
    };

    console.log('[eSocial Proxy] Connecting to', esocialConfig.hostname + path);

    const result = await makeHttpsRequest(options, soapBody);
    
    const elapsed = Date.now() - startTime;
    console.log('[eSocial Proxy] Success in', elapsed + 'ms, response length:', result.data.length);

    res.json({
      success: true,
      data: result.data,
      statusCode: result.statusCode,
      ambiente,
      periodo,
      elapsed
    });

  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error('[eSocial Proxy] Error after', elapsed + 'ms:', error.message);
    
    res.status(500).json({
      success: false,
      error: error.message,
      elapsed
    });
  }
});
function makeHttpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ data, statusCode: res.statusCode });
        } else {
          reject(new Error('eSocial retornou status ' + res.statusCode + ': ' + data.substring(0, 500)));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error('Erro de conexão com eSocial: ' + error.message));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout na conexão com eSocial (30s)'));
    });

    req.write(body);
    req.end();
  });
}

function buildSoapEnvelope(action, tpInsc, nrInsc, perApur, tpEvento) {
  if (action === 'consultar') {
    return '<?xml version="1.0" encoding="utf-8"?>' +
      '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:v1="http://www.esocial.gov.br/servicos/empregador/consulta/retornoProcessamento/v1_0_0">' +
      '<soap:Header/>' +
      '<soap:Body>' +
      '<v1:ConsultarLoteEventos>' +
      '<v1:consulta>' +
      '<eSocial xmlns="http://www.esocial.gov.br/schema/consulta/retornoProcessamento/v1_0_0">' +
      '<consultaLoteEventos>' +
      '<protocoloEnvio>1</protocoloEnvio>' +
      '</consultaLoteEventos>' +
      '</eSocial>' +
      '</v1:consulta>' +
      '</v1:ConsultarLoteEventos>' +
      '</soap:Body>' +
      '</soap:Envelope>';
  }

  const nrInscFormatted = nrInsc.replace(/\D/g, '').substring(0, 8);
  
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:v1="http://www.esocial.gov.br/servicos/empregador/download/v1_0_0">' +
    '<soap:Header/>' +
    '<soap:Body>' +
    '<v1:SolicitarDownloadEventos>' +
    '<v1:solicitacao>' +
    '<eSocial xmlns="http://www.esocial.gov.br/schema/download/solicitacao/v1_0_0">' +
    '<download>' +
    '<ideEmpregador>' +
    '<tpInsc>' + tpInsc + '</tpInsc>' +
    '<nrInsc>' + nrInscFormatted + '</nrInsc>' +
    '</ideEmpregador>' +
    '<solicDownload>' +
    '<perApur>' + perApur + '</perApur>' +
    '<tpEvento>' + tpEvento + '</tpEvento>' +
    '</solicDownload>' +
    '</download>' +
    '</eSocial>' +
    '</v1:solicitacao>' +
    '</v1:SolicitarDownloadEventos>' +
    '</soap:Body>' +
    '</soap:Envelope>';
}

function getCurrentPeriod() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return year + '-' + month;
}

app.listen(PORT, () => {
  console.log('[eSocial Proxy] Server running on port ' + PORT);
  console.log('[eSocial Proxy] Health check: http://localhost:' + PORT + '/health');
  console.log('[eSocial Proxy] API endpoint: POST http://localhost:' + PORT + '/api/esocial');
});
