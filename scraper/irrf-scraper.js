// esocial-proxy/scraper/irrf-scraper.js

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

puppeteer.use(StealthPlugin());

// Seletores CSS para elementos do portal eSocial
const SELECTORS = {
  // Login gov.br
  btnEntrarGovBr: 'button[data-testid="signin-button"], .btn-login, a[href*="sso.acesso.gov.br"]',
  btnCertificadoDigital: 'a[data-testid="certificate-login-btn"], a[href*="certificate"], .certificate-option',
  
  // Menu principal eSocial
  menuFolhaPagamento: 'a[title="Folha de Pagamento"], span:contains("Folha de Pagamento")',
  menuTotalizadores: 'a[title="Totalizadores"], span:contains("Totalizadores")',
  menuTrabalhador: 'a[title="Trabalhador"], span:contains("Trabalhador")',
  menuIRRF: 'a[title="IRRF"], span:contains("IRRF")',
  
  // Formulário de consulta
  inputCpf: 'input[name="cpf"], input[id*="cpf"], input[placeholder*="CPF"]',
  inputPeriodo: 'input[name="periodo"], input[id*="periodo"], input[placeholder*="Período"]',
  btnConsultar: 'button[type="submit"], button:contains("Consultar"), input[type="submit"]',
  
  // Resultados
  tabelaResultados: 'table.resultado, table[id*="resultado"], .grid-resultado',
  btnDownloadXml: 'a[href*="xml"], button:contains("XML"), a:contains("Baixar XML")'
};

// Funções auxiliares
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function findElementByText(page, selector, text) {
  const elements = await page.$$(selector);
  for (const element of elements) {
    const textContent = await page.evaluate(el => el.textContent, element);
    if (textContent && textContent.includes(text)) {
      return element;
    }
  }
  return null;
}

async function clickByText(page, text, timeout = 10000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const clicked = await page.evaluate((searchText) => {
      const elements = document.querySelectorAll('a, button, span, div');
      for (const el of elements) {
        if (el.textContent && el.textContent.trim().includes(searchText)) {
          el.click();
          return true;
        }
      }
      return false;
    }, text);
    if (clicked) return true;
    await sleep(500);
  }
  return false;
}

async function debugDumpInputs(page) {
  return await page.evaluate(() => {
    const inputs = document.querySelectorAll('input, select, textarea');
    return Array.from(inputs).map(el => ({
      tag: el.tagName,
      type: el.type,
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      value: el.value,
      visible: el.offsetParent !== null
    }));
  });
}

async function findInputHandleByLabel(page, labelText) {
  return await page.evaluateHandle((searchLabel) => {
    const labels = document.querySelectorAll('label');
    for (const label of labels) {
      if (label.textContent && label.textContent.includes(searchLabel)) {
        const forAttr = label.getAttribute('for');
        if (forAttr) {
          return document.getElementById(forAttr);
        }
        const input = label.querySelector('input, select, textarea');
        if (input) return input;
        const nextInput = label.nextElementSibling;
        if (nextInput && ['INPUT', 'SELECT', 'TEXTAREA'].includes(nextInput.tagName)) {
          return nextInput;
        }
      }
    }
    return null;
  }, labelText);
}

async function getVisibleTextInputs(page) {
  return await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
    return Array.from(inputs)
      .filter(el => el.offsetParent !== null)
      .map(el => ({
        id: el.id,
        name: el.name,
        placeholder: el.placeholder
      }));
  });
}

class ESocialIRRFScraper {
  constructor(certificatePfx, password) {
    this.certificatePfx = certificatePfx; // Base64 encoded PFX
    this.password = password;
    this.browser = null;
    this.page = null;
    this.tempDir = null;
    this.nssDbDir = null;
  }

  async init() {
    console.log('[Scraper] Iniciando configuração do certificado...');
    
    // Criar diretório temporário para arquivos do certificado
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esocial-cert-'));
    console.log('[Scraper] Diretório temporário:', this.tempDir);
    
    // Salvar certificado PFX em arquivo temporário
    const pfxPath = path.join(this.tempDir, 'certificate.pfx');
    const pfxBuffer = Buffer.from(this.certificatePfx, 'base64');
    fs.writeFileSync(pfxPath, pfxBuffer);
    console.log('[Scraper] Certificado PFX salvo:', pfxPath);
    
    // Criar arquivo de senha
    const passwordFile = path.join(this.tempDir, 'password.txt');
    fs.writeFileSync(passwordFile, this.password);
    
    // Criar diretório NSS database para o Chrome
    this.nssDbDir = path.join(this.tempDir, 'nssdb');
    fs.mkdirSync(this.nssDbDir, { recursive: true });
    
    // Criar diretório de perfil do Chrome
    const chromeProfileDir = path.join(this.tempDir, 'chrome-profile');
    fs.mkdirSync(chromeProfileDir, { recursive: true });
    
    // NSS database dentro do perfil do Chrome
    const nssDbInProfile = path.join(chromeProfileDir, 'nssdb');
    fs.mkdirSync(nssDbInProfile, { recursive: true });
    
    // Inicializar NSS database
    try {
      execSync(`certutil -d sql:${nssDbInProfile} -N --empty-password`, { stdio: 'pipe' });
      console.log('[Scraper] NSS database inicializado');
    } catch (e) {
      console.log('[Scraper] NSS database já existe ou erro:', e.message);
    }
    
    // Importar certificado PFX para NSS database
    try {
      const importCmd = `pk12util -d sql:${nssDbInProfile} -i ${pfxPath} -w ${passwordFile}`;
      console.log('[Scraper] Executando:', importCmd);
      const importResult = execSync(importCmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      console.log('[Scraper] Certificado importado com sucesso');
      console.log('[Scraper] Import result:', importResult);
    } catch (e) {
      console.error('[Scraper] Erro ao importar certificado:', e.message);
      if (e.stderr) console.error('[Scraper] STDERR:', e.stderr.toString());
      throw new Error('Falha ao importar certificado PFX: ' + e.message);
    }
    
    // Listar certificados importados
    try {
      const certList = execSync(`certutil -d sql:${nssDbInProfile} -L`, { encoding: 'utf-8' });
      console.log('[Scraper] Certificados no NSS database:\n', certList);
    } catch (e) {
      console.log('[Scraper] Não foi possível listar certificados:', e.message);
    }

    // NOVO: Verificar se a chave privada foi importada (essencial para autenticação)
    try {
      const keyList = execSync(`certutil -d sql:${nssDbInProfile} -K -f ${passwordFile}`, {
        encoding: 'utf-8',
        timeout: 10000
      });
      console.log('[Scraper] Private keys in NSS database:\n', keyList);
    } catch (e) {
      console.log('[Scraper] AVISO: Não foi possível listar chaves privadas:', e.message);
      console.log('[Scraper] Isso pode indicar que o certificado não foi importado corretamente');
    }
    
    // Configurar variáveis de ambiente para NSS
    process.env.NSS_DEFAULT_DB_TYPE = 'sql';
    
    console.log('[Scraper] Iniciando navegador...');
    
    // Iniciar Puppeteer com configurações para certificado digital
    this.browser = await puppeteer.launch({
      headless: false, // IMPORTANTE: Precisa ser false para certificado digital
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--display=' + (process.env.DISPLAY || ':99'),
        '--ignore-certificate-errors',
        '--allow-running-insecure-content',
        // CORRIGIDO: Auto-selecionar certificado - formato JSON correto
        '--auto-select-certificate-for-urls={"pattern":"*","filter":{}}',
        // Usar o perfil com o NSS database que contém o certificado
        `--user-data-dir=${chromeProfileDir}`,
      ],
      defaultViewport: { width: 1920, height: 1080 },
      timeout: 60000
    });
    
    this.page = await this.browser.newPage();
    
    // Configurar user agent
    await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Configurar timeout padrão
    this.page.setDefaultTimeout(60000);
    this.page.setDefaultNavigationTimeout(60000);
    
    console.log('[Scraper] Navegador iniciado com sucesso');
    
    return this;
  }

  async login() {
    console.log('[Scraper] Iniciando processo de login...');
    
    try {
      // PASSO 1: Navegar para página inicial do eSocial
      console.log('[Scraper] PASSO 1: Navegando para portal eSocial...');
      await this.page.goto('https://login.esocial.gov.br/login.aspx', { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      });
      await sleep(3000);
      
      console.log('[Scraper] Página carregada:', await this.page.url());
      console.log('[Scraper] Título:', await this.page.title());
      
      // PASSO 2: Clicar em "Entrar com gov.br"
      console.log('[Scraper] PASSO 2: Procurando botão "Entrar com gov.br"...');
      
      let clicked = await clickByText(this.page, 'Entrar com gov.br', 15000);
      if (!clicked) {
        clicked = await clickByText(this.page, 'gov.br', 5000);
      }
      if (!clicked) {
        // Tentar por seletores específicos
        const govBrBtn = await this.page.$('a[href*="sso.acesso.gov.br"], button[class*="gov"], .btn-govbr');
        if (govBrBtn) {
          await govBrBtn.click();
          clicked = true;
        }
      }
      
      if (!clicked) {
        console.log('[Scraper] AVISO: Botão gov.br não encontrado, talvez já esteja na página de login');
      } else {
        console.log('[Scraper] Botão gov.br clicado, aguardando navegação...');
        await sleep(5000);
      }
      
      console.log('[Scraper] URL após gov.br:', await this.page.url());
      
      // PASSO 3: Clicar em "Seu certificado digital"
      console.log('[Scraper] PASSO 3: Procurando opção "Certificado Digital"...');
      
      clicked = await clickByText(this.page, 'Seu certificado digital', 15000);
      if (!clicked) {
        clicked = await clickByText(this.page, 'certificado digital', 10000);
      }
      if (!clicked) {
        clicked = await clickByText(this.page, 'Certificado', 5000);
      }
      if (!clicked) {
        // Tentar por seletores específicos
        const certBtn = await this.page.$('a[href*="certificate"], button[class*="cert"], .certificate-option');
        if (certBtn) {
          await certBtn.click();
          clicked = true;
        }
      }
      
      if (!clicked) {
        throw new Error('Não foi possível encontrar opção de certificado digital');
      }
      
      console.log('[Scraper] Opção de certificado clicada');
      
      // PASSO 4: Aguardar seleção automática de certificado pelo Chrome
      console.log('[Scraper] PASSO 4: Aguardando seleção automática de certificado...');
      console.log('[Scraper] Auto-select configurado para qualquer URL que pedir certificado');
      console.log('[Scraper] Se popup aparecer, Chrome deve selecionar automaticamente do NSS database');
      
      // O Chrome deve auto-selecionar o certificado do NSS database
      // Aguardar tempo para o popup aparecer e ser tratado automaticamente
      await sleep(8000);
      
      console.log('[Scraper] URL após certificado:', await this.page.url());
      
      // PASSO 5: Aguardar redirecionamento de volta ao eSocial
      console.log('[Scraper] PASSO 5: Aguardando autenticação completar...');
      
      const maxWait = 60000; // 60 segundos
      const startTime = Date.now();
      
      while (Date.now() - startTime < maxWait) {
        const currentUrl = await this.page.url();
        console.log('[Scraper] URL atual:', currentUrl);
        
        // Verificar se voltou para o eSocial autenticado
        if (currentUrl.includes('esocial.gov.br') && !currentUrl.includes('login.aspx')) {
          console.log('[Scraper] Login completado com sucesso!');
          await sleep(3000);
          return true;
        }
        
        // Verificar erros de autenticação
        const errorMessage = await this.page.evaluate(() => {
          const errorElements = document.querySelectorAll('.error, .alert-danger, .mensagem-erro');
          return Array.from(errorElements).map(el => el.textContent).filter(t => t);
        });
        
        if (errorMessage.length > 0) {
          throw new Error('Erro de autenticação: ' + errorMessage.join(', '));
        }
        
        await sleep(2000);
      }
      
      // Timeout - verificar estado atual
      const finalUrl = await this.page.url();
      const pageTitle = await this.page.title();
      const errorMessages = await this.page.evaluate(() => {
        const errors = document.querySelectorAll('.error, .alert, .message');
        return Array.from(errors).map(el => el.textContent).filter(t => t && t.trim());
      });
      
      throw new Error(`Login não completado. Ainda na página de login. Debug: ${JSON.stringify({
        url: finalUrl,
        title: pageTitle,
        errorMessages
      })}`);
      
    } catch (error) {
      console.error('[Scraper] Erro no login:', error.message);
      throw error;
    }
  }

  async navigateToIRRF() {
    console.log('[Scraper] Navegando para consulta IRRF...');
    
    try {
      // Navegar pelo menu: Folha de Pagamento > Totalizadores > Trabalhador > IRRF
      
      // Clicar em "Folha de Pagamento"
      console.log('[Scraper] Clicando em "Folha de Pagamento"...');
      await clickByText(this.page, 'Folha de Pagamento', 10000);
      await sleep(2000);
      
      // Clicar em "Totalizadores"
      console.log('[Scraper] Clicando em "Totalizadores"...');
      await clickByText(this.page, 'Totalizadores', 10000);
      await sleep(2000);
      
      // Clicar em "Trabalhador"
      console.log('[Scraper] Clicando em "Trabalhador"...');
      await clickByText(this.page, 'Trabalhador', 10000);
      await sleep(2000);
      
      // Clicar em "IRRF"
      console.log('[Scraper] Clicando em "IRRF"...');
      await clickByText(this.page, 'IRRF', 10000);
      await sleep(3000);
      
      console.log('[Scraper] Navegação para IRRF concluída');
      console.log('[Scraper] URL atual:', await this.page.url());
      
      return true;
    } catch (error) {
      console.error('[Scraper] Erro na navegação:', error.message);
      throw error;
    }
  }

  async consultarIRRF(cpf, periodo) {
    console.log(`[Scraper] Consultando IRRF para CPF ${cpf}, período ${periodo}...`);
    
    try {
      // Aguardar formulário carregar
      await sleep(2000);
      
      // Debug: listar inputs disponíveis
      const inputs = await debugDumpInputs(this.page);
      console.log('[Scraper] Inputs disponíveis:', JSON.stringify(inputs, null, 2));
      
      // Preencher CPF
      console.log('[Scraper] Preenchendo CPF...');
      const cpfInput = await findInputHandleByLabel(this.page, 'CPF');
      if (cpfInput) {
        await cpfInput.type(cpf.replace(/\D/g, ''));
      } else {
        // Fallback: procurar por placeholder ou name
        const cpfField = await this.page.$('input[placeholder*="CPF"], input[name*="cpf"], input[id*="cpf"]');
        if (cpfField) {
          await cpfField.type(cpf.replace(/\D/g, ''));
        } else {
          throw new Error('Campo CPF não encontrado');
        }
      }
      
      // Preencher período
      console.log('[Scraper] Preenchendo período...');
      const periodoInput = await findInputHandleByLabel(this.page, 'Período');
      if (periodoInput) {
        await periodoInput.type(periodo);
      } else {
        // Fallback
        const periodoField = await this.page.$('input[placeholder*="Período"], input[name*="periodo"], input[id*="periodo"]');
        if (periodoField) {
          await periodoField.type(periodo);
        } else {
          console.log('[Scraper] AVISO: Campo período não encontrado, continuando...');
        }
      }
      
      await sleep(1000);
      
      // Clicar em Consultar
      console.log('[Scraper] Clicando em Consultar...');
      const clicked = await clickByText(this.page, 'Consultar', 10000);
      if (!clicked) {
        const submitBtn = await this.page.$('button[type="submit"], input[type="submit"]');
        if (submitBtn) {
          await submitBtn.click();
        }
      }
      
      // Aguardar resultado
      await sleep(5000);
      
      console.log('[Scraper] Consulta realizada, verificando resultados...');
      
      // Tentar baixar XML
      const xmlData = await this.downloadXML();
      if (xmlData) {
        return { success: true, data: xmlData, type: 'xml' };
      }
      
      // Se não conseguir XML, extrair dados da tela
      const screenData = await this.extractDataFromScreen();
      if (screenData) {
        return { success: true, data: screenData, type: 'screen' };
      }
      
      return { success: false, error: 'Nenhum dado encontrado' };
      
    } catch (error) {
      console.error('[Scraper] Erro na consulta:', error.message);
      return { success: false, error: error.message };
    }
  }

  async downloadXML() {
    console.log('[Scraper] Tentando baixar XML...');
    
    try {
      // Procurar link/botão de download XML
      const xmlBtn = await this.page.$('a[href*="xml"], button:contains("XML"), a:contains("Baixar")');
      if (!xmlBtn) {
        console.log('[Scraper] Botão XML não encontrado');
        return null;
      }
      
      // Interceptar download
      const client = await this.page.target().createCDPSession();
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: this.tempDir
      });
      
      await xmlBtn.click();
      await sleep(5000);
      
      // Procurar arquivo XML baixado
      const files = fs.readdirSync(this.tempDir);
      const xmlFile = files.find(f => f.endsWith('.xml'));
      
      if (xmlFile) {
        const xmlPath = path.join(this.tempDir, xmlFile);
        const xmlContent = fs.readFileSync(xmlPath, 'utf-8');
        console.log('[Scraper] XML baixado com sucesso');
        return xmlContent;
      }
      
      return null;
    } catch (error) {
      console.log('[Scraper] Erro ao baixar XML:', error.message);
      return null;
    }
  }

  async extractDataFromScreen() {
    console.log('[Scraper] Extraindo dados da tela...');
    
    try {
      const data = await this.page.evaluate(() => {
        const result = {};
        
        // Procurar tabela de resultados
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
          const rows = table.querySelectorAll('tr');
          const tableData = [];
          
          rows.forEach(row => {
            const cells = row.querySelectorAll('td, th');
            const rowData = Array.from(cells).map(cell => cell.textContent.trim());
            if (rowData.length > 0) {
              tableData.push(rowData);
            }
          });
          
          if (tableData.length > 0) {
            result.tableData = tableData;
            break;
          }
        }
        
        // Procurar campos específicos de IRRF
        const labels = document.querySelectorAll('label, span, div');
        const fields = {};
        
        labels.forEach(label => {
          const text = label.textContent.trim();
          if (text.includes('Base') || text.includes('IRRF') || text.includes('Valor') || 
              text.includes('Dedução') || text.includes('Alíquota')) {
            const nextElement = label.nextElementSibling;
            if (nextElement) {
              fields[text] = nextElement.textContent.trim();
            }
          }
        });
        
        result.fields = fields;
        
        return result;
      });
      
      console.log('[Scraper] Dados extraídos:', JSON.stringify(data, null, 2));
      return data;
      
    } catch (error) {
      console.log('[Scraper] Erro ao extrair dados:', error.message);
      return null;
    }
  }

  async processMultiple(cpfs, periodos) {
    console.log(`[Scraper] Processando ${cpfs.length} CPFs para ${periodos.length} períodos...`);
    
    const results = [];
    
    try {
      // Inicializar
      await this.init();
      
      // Login
      await this.login();
      
      // Navegar para IRRF
      await this.navigateToIRRF();
      
      // Processar cada CPF/período
      for (const cpf of cpfs) {
        for (const periodo of periodos) {
          console.log(`[Scraper] Processando CPF ${cpf}, período ${periodo}...`);
          
          const result = await this.consultarIRRF(cpf, periodo);
          results.push({
            cpf,
            periodo,
            ...result
          });
          
          // Aguardar entre consultas para evitar bloqueio
          await sleep(2000);
        }
      }
      
      return { success: true, results };
      
    } catch (error) {
      console.error('[Scraper] Erro no processamento:', error.message);
      return { 
        success: false, 
        error: error.message,
        results 
      };
    }
  }

  async close() {
    console.log('[Scraper] Fechando navegador...');
    
    if (this.browser) {
      await this.browser.close();
    }
    
    // Limpar arquivos temporários
    if (this.tempDir && fs.existsSync(this.tempDir)) {
      try {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
        console.log('[Scraper] Arquivos temporários removidos');
      } catch (e) {
        console.log('[Scraper] Erro ao remover arquivos temporários:', e.message);
      }
    }
    
    console.log('[Scraper] Scraper finalizado');
  }
}

module.exports = { ESocialIRRFScraper };
