/**
 * eSocial Proxy Server
 * 
 * Proxy Node.js para comunicação mTLS com o portal eSocial.
 * Necessário porque Supabase Edge Functions não conseguem resolver domínios .gov.br
 * 
 * Deploy: Render.com, Railway.app, DigitalOcean, Fly.io, ou qualquer servidor com Node.js
 */

// ========== VERSÃO DO PROXY ==========
const PROXY_VERSION = 'v2.1.0-sso-fix-2024-12-31';
console.log(`[eSocial Proxy] ========================================`);
console.log(`[eSocial Proxy] VERSÃO: ${PROXY_VERSION}`);
console.log(`[eSocial Proxy] Build: ${new Date().toISOString()}`);
console.log(`[eSocial Proxy] ========================================`);

const express = require('express');
const https = require('https');
const cors = require('cors');
const { ESocialIRRFScraper } = require('./scraper/irrf-scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS - permitir chamadas do Lovable (tanto edge functions quanto browser direto)
const allowedOrigins = [
  /\.lovable\.app$/,
  /\.lovableproject\.com$/,
  /\.supabase\.co$/,
  /localhost:\d+$/,
  /127\.0\.0\.1:\d+$/
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, etc.)
    if (!origin) return callback(null, true);
    const isAllowed = allowedOrigins.some(pattern => 
      pattern instanceof RegExp ? pattern.test(origin) : origin === pattern
    );
    // If not in whitelist, still allow but log it (for debugging browser direct calls)
    if (!isAllowed) {
      console.log(`[CORS] Origin not in whitelist but allowing: ${origin}`);
    }
    callback(null, true); // Allow all origins for now (proxy is public anyway)
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '10mb' }));

// Rate limiting simples
const requestCounts = new Map();
const RATE_LIMIT = 100; // requests por minuto
const RATE_WINDOW = 60000; // 1 minuto

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

// ============================================================
// NOVO ENDPOINT: Web Scraping para IRRF por trabalhador
// ============================================================
app.post('/api/esocial-irrf', rateLimit, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { certificatePfx, password, cpfs, periodos } = req.body;

    // Validação
    if (!certificatePfx || !password) {
      return res.status(400).json({ 
        success: false, 
        error: 'Certificado digital (certificatePfx) e senha são obrigatórios' 
      });
    }

    if (!cpfs || !Array.isArray(cpfs) || cpfs.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Lista de CPFs é obrigatória' 
      });
    }

    if (!periodos || !Array.isArray(periodos) || periodos.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Lista de períodos é obrigatória' 
      });
    }

    console.log(`[eSocial IRRF] Request: ${cpfs.length} CPFs, ${periodos.length} períodos`);
    console.log(`[eSocial IRRF] CPFs: ${cpfs.join(', ')}`);
    console.log(`[eSocial IRRF] Períodos: ${periodos.join(', ')}`);

    // Iniciar scraper
    const scraper = new ESocialIRRFScraper(certificatePfx, password);
    
    try {
      const results = await scraper.processMultiple(cpfs, periodos);
      await scraper.close();
      
      const elapsed = Date.now() - startTime;
      
      // CORREÇÃO: Garantir que results é array antes de usar .filter()
      const safeResults = Array.isArray(results) ? results : [];
      
      if (!Array.isArray(results)) {
        console.error('[eSocial IRRF] AVISO: scraper retornou algo que não é array:', typeof results);
        return res.status(500).json({
          success: false,
          error: 'Resposta inesperada do scraper (não é array)',
          details: {
            type: typeof results,
            preview: String(results).substring(0, 200)
          },
          elapsed
        });
      }
      
      const successCount = safeResults.filter(r => r && r.success).length;
      
      console.log(`[eSocial IRRF] Completed: ${successCount}/${safeResults.length} successful in ${elapsed}ms`);

      res.json({
        success: true,
        data: safeResults,
        summary: {
          total: safeResults.length,
          successful: successCount,
          failed: safeResults.length - successCount
        },
        elapsed
      });
      
    } catch (scraperError) {
      await scraper.close();
      throw scraperError;
    }

  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(`[eSocial IRRF] Error after ${elapsed}ms:`, error.message);
    
    res.status(500).json({
      success: false,
      error: error.message,
      elapsed
    });
  }
});

// ============================================================
// ENDPOINT EXISTENTE: mTLS direto (mantido para compatibilidade)
// ============================================================
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

    // Validação de payload
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

    console.log(`[eSocial Proxy] Request: ${requestAction}, Ambiente: ${ambiente}, CNPJ: ${nrInsc}, Período: ${periodo}`);

    // Configuração do eSocial
    const esocialConfig = ESOCIAL_URLS[ambiente];
    const path = requestAction === 'consultar' ? esocialConfig.consulta : esocialConfig.download;
    
    // Monta envelope SOAP
    const soapBody = buildSoapEnvelope(requestAction, tpInsc, nrInsc, periodo, eventoTipo);

    // SOAPAction header
    const soapAction = requestAction === 'consultar'
      ? 'http://www.esocial.gov.br/servicos/empregador/consulta/retornoProcessamento/v1_0_0/ServicoConsultarLoteEventos/ConsultarLoteEventos'
      : 'http://www.esocial.gov.br/servicos/empregador/download/v1_0_0/ServicoDownload/Download';

    // Opções da requisição mTLS
    const options = {
      hostname: esocialConfig.hostname,
      port: 443,
      path: path,
      method: 'POST',
      key: privateKeyPem,
      cert: certificatePem,
      rejectUnauthorized: true, // Validar certificado do servidor
      headers: {
        'Content-Type': 'application/soap+xml;charset=UTF-8',
        'Content-Length': Buffer.byteLength(soapBody, 'utf8'),
        'SOAPAction': soapAction
      },
      timeout: 30000 // 30 segundos
    };

    console.log(`[eSocial Proxy] Connecting to ${esocialConfig.hostname}${path}`);

    // Executa requisição mTLS
    const result = await makeHttpsRequest(options, soapBody);
    
    const elapsed = Date.now() - startTime;
    console.log(`[eSocial Proxy] Success in ${elapsed}ms, response length: ${result.data.length}`);

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
    console.error(`[eSocial Proxy] Error after ${elapsed}ms:`, error.message);
    
    res.status(500).json({
      success: false,
      error: error.message,
      elapsed
    });
  }
});

/**
 * Faz requisição HTTPS com mTLS
 */
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
          reject(new Error(`eSocial retornou status ${res.statusCode}: ${data.substring(0, 500)}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Erro de conexão com eSocial: ${error.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout na conexão com eSocial (30s)'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Constrói envelope SOAP para requisições ao eSocial
 */
function buildSoapEnvelope(action, tpInsc, nrInsc, perApur, tpEvento) {
  if (action === 'consultar') {
    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:v1="http://www.esocial.gov.br/servicos/empregador/consulta/retornoProcessamento/v1_0_0">
  <soap:Header/>
  <soap:Body>
    <v1:ConsultarLoteEventos>
      <v1:consulta>
        <eSocial xmlns="http://www.esocial.gov.br/schema/consulta/retornoProcessamento/v1_0_0">
          <consultaLoteEventos>
            <protocoloEnvio>1</protocoloEnvio>
          </consultaLoteEventos>
        </eSocial>
      </v1:consulta>
    </v1:ConsultarLoteEventos>
  </soap:Body>
</soap:Envelope>`;
  }

  // Download de eventos
  const nrInscFormatted = nrInsc.replace(/\D/g, '').substring(0, 8);
  
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:v1="http://www.esocial.gov.br/servicos/empregador/download/v1_0_0">
  <soap:Header/>
  <soap:Body>
    <v1:SolicitarDownloadEventos>
      <v1:solicitacao>
        <eSocial xmlns="http://www.esocial.gov.br/schema/download/solicitacao/v1_0_0">
          <download>
            <ideEmpregador>
              <tpInsc>${tpInsc}</tpInsc>
              <nrInsc>${nrInscFormatted}</nrInsc>
            </ideEmpregador>
            <solicDownload>
              <perApur>${perApur}</perApur>
              <tpEvento>${tpEvento}</tpEvento>
            </solicDownload>
          </download>
        </eSocial>
      </v1:solicitacao>
    </v1:SolicitarDownloadEventos>
  </soap:Body>
</soap:Envelope>`;
}

/**
 * Retorna período atual no formato YYYY-MM
 */
function getCurrentPeriod() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// Inicia servidor
app.listen(PORT, () => {
  console.log(`[eSocial Proxy] Server running on port ${PORT}`);
  console.log(`[eSocial Proxy] Health check: http://localhost:${PORT}/health`);
  console.log(`[eSocial Proxy] API endpoints:`);
  console.log(`  - POST http://localhost:${PORT}/api/esocial (mTLS direto)`);
  console.log(`  - POST http://localhost:${PORT}/api/esocial-irrf (Web Scraping IRRF)`);
});
