/**
 * eSocial IRRF Scraper
 * 
 * Automatiza a navegação no portal eSocial para consultar IRRF por trabalhador
 * Fluxo: Folha de Pagamento > Totalizadores > Trabalhador > IRRF por trabalhador
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

puppeteer.use(StealthPlugin());

// Helper function to replace deprecated waitForTimeout
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Seletores CSS do portal eSocial (apenas seletores CSS válidos)
const SELECTORS = {
  // Login - seletores CSS válidos apenas
  loginCertificado: 'button[data-option="certificado"], .btn-certificado, #btn-certificado, .certificate-login',
  
  // Menu de navegação
  menuFolhaPagamento: '[data-menu="folha-pagamento"], a[href*="folha"], .menu-folha',
  submenuTotalizadores: 'a[href*="totalizadores"], .submenu-totalizadores',
  submenuTrabalhador: 'a[href*="trabalhador"], .submenu-trabalhador',
  optionIRRF: 'a[href*="irrf"], .option-irrf-trabalhador',
  
  // Formulário de pesquisa IRRF
  inputPeriodo: '#periodo, input[name="periodo"], input[id*="periodo"], input[placeholder*="Período"]',
  inputCPF: '#cpf, input[name="cpf"], input[id*="cpf"], input[placeholder*="CPF"]',
  btnPesquisar: 'button[type="submit"], .btn-pesquisar, input[type="submit"]',
  
  // Resultado
  resultadoContainer: '.resultado-consulta, .informacoes-demonstrativo, .dados-irrf, table.resultado',
  btnBaixarXML: '.btn-baixar-xml, a[href*="download"], button[id*="xml"], a[id*="xml"]',
  btnVoltar: '.btn-voltar, a[href*="voltar"], button[id*="voltar"]',
  
  // Mensagens
  msgSemDados: '.msg-sem-dados, .alert-info, .no-data',
  msgErro: '.msg-erro, .alert-danger, .error-message'
};

// Helper function to find element by text content (replacement for :contains())
async function findElementByText(page, text, tagSelector = '*') {
  return await page.evaluateHandle((text, tagSelector) => {
    const elements = document.querySelectorAll(tagSelector);
    for (const el of elements) {
      if (el.textContent && el.textContent.includes(text)) {
        return el;
      }
    }
    return null;
  }, text, tagSelector);
}

// Helper to click element by text
async function clickByText(page, text, tagSelector = 'button, a, input[type="submit"]') {
  const clicked = await page.evaluate((text, tagSelector) => {
    const elements = document.querySelectorAll(tagSelector);
    for (const el of elements) {
      if (el.textContent && el.textContent.toLowerCase().includes(text.toLowerCase())) {
        el.click();
        return true;
      }
    }
    return false;
  }, text, tagSelector);
  return clicked;
}

async function debugDumpInputs(page, label) {
  try {
    const safeLabel = String(label || 'debug').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 50);
    const ts = Date.now();

    await page.screenshot({ path: `/tmp/esocial_${safeLabel}_${ts}.png`, fullPage: true });

    const inputs = await page.$$eval('input, select, textarea', (els) =>
      els.map((el) => {
        const rect = (el instanceof HTMLElement) ? el.getBoundingClientRect() : null;
        const isVisible = !!rect && rect.width > 0 && rect.height > 0;

        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          name: el.getAttribute('name') || null,
          type: (el instanceof HTMLInputElement) ? (el.getAttribute('type') || 'text') : null,
          placeholder: el.getAttribute('placeholder') || null,
          ariaLabel: el.getAttribute('aria-label') || null,
          className: (el instanceof HTMLElement) ? el.className : null,
          isVisible,
        };
      })
    );

    console.log(`[Scraper][Debug] Inputs (${safeLabel}) =`, JSON.stringify(inputs, null, 2));
  } catch (e) {
    console.log('[Scraper][Debug] Failed to dump inputs:', e?.message || e);
  }
}

async function findInputHandleByLabel(page, labelIncludes) {
  const handle = await page.evaluateHandle((labelIncludes) => {
    const needle = String(labelIncludes || '').toLowerCase();
    const labels = Array.from(document.querySelectorAll('label'));

    const matchLabel = labels.find((l) => (l.textContent || '').toLowerCase().includes(needle));
    if (!matchLabel) return null;

    const forId = matchLabel.getAttribute('for');
    if (forId) {
      return document.getElementById(forId);
    }

    // label wraps input
    const nested = matchLabel.querySelector('input, select, textarea');
    if (nested) return nested;

    // label followed by input
    let next = matchLabel.nextElementSibling;
    while (next) {
      if (next.matches && next.matches('input, select, textarea')) return next;
      const child = next.querySelector?.('input, select, textarea');
      if (child) return child;
      next = next.nextElementSibling;
    }

    return null;
  }, labelIncludes);

  const el = handle.asElement();
  if (!el) {
    await handle.dispose();
    return null;
  }

  return el;
}

async function getVisibleTextInputs(page) {
  const candidates = await page.$$('input[type="text"], input:not([type]), input[type="tel"], input[type="search"]');
  const visible = [];

  for (const h of candidates) {
    try {
      const box = await h.boundingBox();
      const disabled = await page.evaluate((el) => {
        const anyEl = el;
        return !!anyEl.disabled || anyEl.getAttribute?.('aria-disabled') === 'true';
      }, h);

      if (box && box.width > 0 && box.height > 0 && !disabled) visible.push(h);
    } catch {
      // ignore
    }
  }

  return visible;
}

class ESocialIRRFScraper {
  constructor(certificatePfx, password) {
    this.certificatePfxBase64 = certificatePfx;
    this.password = password;
    this.browser = null;
    this.page = null;
    this.tempCertPath = null;
    this.tempNssDb = null;
    this.tempUserDataDir = null;
  }

  async init() {
    console.log('[Scraper] Initializing Puppeteer with NSS certificate support...');
    
    const timestamp = Date.now();
    
    // 1. Salvar certificado PFX em arquivo temporário
    this.tempCertPath = path.join(os.tmpdir(), `cert_${timestamp}.pfx`);
    const certBuffer = Buffer.from(this.certificatePfxBase64, 'base64');
    fs.writeFileSync(this.tempCertPath, certBuffer);
    console.log('[Scraper] Certificate saved to temp file');

    // 2. Criar diretório NSS database temporário
    this.tempNssDb = path.join(os.tmpdir(), `nssdb_${timestamp}`);
    fs.mkdirSync(this.tempNssDb, { recursive: true });
    console.log('[Scraper] NSS database directory created:', this.tempNssDb);

    // 3. Criar diretório userDataDir para o Chrome (separado do NSS)
    this.tempUserDataDir = path.join(os.tmpdir(), `chrome_profile_${timestamp}`);
    fs.mkdirSync(this.tempUserDataDir, { recursive: true });
    
    // Criar estrutura de diretórios necessária para NSS no Chrome
    const nssDbInProfile = path.join(this.tempUserDataDir, 'nssdb');
    fs.mkdirSync(nssDbInProfile, { recursive: true });
    
    try {
      // 4. Inicializar NSS database vazia
      console.log('[Scraper] Initializing NSS database...');
      execSync(`certutil -d sql:${nssDbInProfile} -N --empty-password`, { 
        stdio: 'pipe',
        timeout: 30000 
      });
      console.log('[Scraper] NSS database initialized');

      // 5. Importar certificado PFX no NSS database
      console.log('[Scraper] Importing certificate into NSS database...');
      
      // Escapar senha para shell (substituir aspas simples)
      const escapedPassword = this.password.replace(/'/g, "'\\''");
      
      execSync(`pk12util -d sql:${nssDbInProfile} -i "${this.tempCertPath}" -W '${escapedPassword}'`, {
        stdio: 'pipe',
        timeout: 30000
      });
      console.log('[Scraper] Certificate imported successfully');

      // Listar certificados para confirmar importação
      try {
        const certList = execSync(`certutil -d sql:${nssDbInProfile} -L`, { 
          encoding: 'utf-8',
          timeout: 10000 
        });
        console.log('[Scraper] Certificates in NSS database:\n', certList);
      } catch (e) {
        console.log('[Scraper] Could not list certificates:', e.message);
      }

    } catch (error) {
      console.error('[Scraper] NSS setup error:', error.message);
      console.error('[Scraper] Stderr:', error.stderr?.toString() || 'N/A');
      
      // Verificar se as ferramentas estão instaladas
      try {
        execSync('which certutil pk12util', { stdio: 'pipe' });
      } catch {
        throw new Error('libnss3-tools não está instalado. Execute: apt-get install -y libnss3-tools');
      }
      
      throw new Error(`Falha ao configurar certificado NSS: ${error.message}`);
    }

    // 6. Iniciar browser com NSS configurado (headless: false para popup de certificado)
    console.log('[Scraper] Launching browser with certificate support...');
    console.log('[Scraper] DISPLAY env:', process.env.DISPLAY);
    
    this.browser = await puppeteer.launch({
      headless: false, // IMPORTANTE: false para permitir popup de certificado via Xvfb
      userDataDir: this.tempUserDataDir,
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
  // Auto-selecionar certificado - formato JSON correto
  '--auto-select-certificate-for-urls={"pattern":"*","filter":{}}',
],
    });

    this.page = await this.browser.newPage();
    
    // Configurar viewport e user agent
    await this.page.setViewport({ width: 1920, height: 1080 });
    await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Timeout padrão
    this.page.setDefaultTimeout(30000);
    this.page.setDefaultNavigationTimeout(60000);

    // Listener para requests de certificado cliente
    this.page.on('request', request => {
      if (request.url().includes('esocial.gov.br') || request.url().includes('gov.br')) {
        console.log('[Scraper] Request to:', request.url());
      }
    });

    // Listener para console do browser
    this.page.on('console', msg => {
      if (msg.type() === 'error' || msg.text().toLowerCase().includes('certificate')) {
        console.log('[Browser Console]', msg.text());
      }
    });

    console.log('[Scraper] Browser initialized with certificate support');
  }

  async login() {
    console.log('[Scraper] === INICIANDO FLUXO DE LOGIN ===');
    
    // ============================================
    // PASSO 1: Acessar página inicial do eSocial
    // ============================================
    console.log('[Scraper] PASSO 1: Acessando página inicial do eSocial...');
    await this.page.goto('https://login.esocial.gov.br/login.aspx', { 
      waitUntil: 'networkidle2' 
    });
    await sleep(2000);
    
    await this.page.screenshot({ path: '/tmp/esocial_01_pagina_inicial.png' });
    console.log('[Scraper] Página inicial carregada. URL:', this.page.url());
    console.log('[Scraper] Título:', await this.page.title());
    
    // Listar elementos clicáveis para debug
    const buttons1 = await this.page.$$eval('button, a, div[role="button"], span[role="button"]', els => 
      els.map(el => ({ 
        tag: el.tagName, 
        text: el.textContent?.trim().substring(0, 60),
        href: el.getAttribute('href') || null
      })).filter(e => e.text)
    );
    console.log('[Scraper] Elementos clicáveis disponíveis:', JSON.stringify(buttons1.slice(0, 15), null, 2));
    
    // ============================================
    // PASSO 2: Clicar em "Entrar com gov.br"
    // ============================================
    console.log('[Scraper] PASSO 2: Procurando botão "Entrar com gov.br"...');
    
    let govBrClicked = await clickByText(this.page, 'Entrar com gov.br', 'a, button, div, span, input');
    
    if (!govBrClicked) {
      // Tentar variações do texto
      const alternatives = ['gov.br', 'entrar com gov', 'acesso gov.br', 'Acesse sua conta'];
      for (const alt of alternatives) {
        govBrClicked = await clickByText(this.page, alt, 'a, button, div, span');
        if (govBrClicked) {
          console.log(`[Scraper] Clicou usando texto alternativo: "${alt}"`);
          break;
        }
      }
    }
    
    if (!govBrClicked) {
      // Tentar seletor de link que contém gov.br na URL
      const linkClicked = await this.page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="gov.br"], a[href*="acesso"], button');
        for (const link of links) {
          if (link.textContent && (link.textContent.includes('gov') || link.textContent.includes('Entrar'))) {
            link.click();
            return true;
          }
        }
        return false;
      });
      govBrClicked = linkClicked;
    }
    
    if (!govBrClicked) {
      await this.page.screenshot({ path: '/tmp/esocial_erro_govbr_nao_encontrado.png' });
      throw new Error('Botão "Entrar com gov.br" não encontrado na página do eSocial');
    }
    
    console.log('[Scraper] Clicou em "Entrar com gov.br". Aguardando redirecionamento...');
    
    // Aguardar redirecionamento para gov.br
    try {
      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    } catch (e) {
      console.log('[Scraper] Timeout na navegação, verificando estado atual...');
    }
    
    await sleep(2000);
    await this.page.screenshot({ path: '/tmp/esocial_02_pagina_govbr.png' });
    
    const govBrUrl = this.page.url();
    console.log('[Scraper] URL após clicar gov.br:', govBrUrl);
    console.log('[Scraper] Título:', await this.page.title());
    
    // Verificar se estamos na página do gov.br
    if (!govBrUrl.includes('acesso.gov.br') && !govBrUrl.includes('sso.acesso.gov.br')) {
      console.log('[Scraper] AVISO: Não parece estar na página do gov.br. Continuando mesmo assim...');
    }
    
    // Listar elementos para debug
    const buttons2 = await this.page.$$eval('a, button, div[role="button"], li', els => 
      els.map(el => el.textContent?.trim().substring(0, 60)).filter(Boolean)
    );
    console.log('[Scraper] Elementos disponíveis na página gov.br:', buttons2.slice(0, 20));
    
    // ============================================
    // PASSO 3: Clicar em "Seu certificado digital"
    // ============================================
    console.log('[Scraper] PASSO 3: Procurando opção "Seu certificado digital"...');
    
    let certClicked = await clickByText(this.page, 'Seu certificado digital', 'a, button, div, span, li, label');
    
    if (!certClicked) {
      // Tentar variações
      const certAlternatives = ['certificado digital', 'Certificado Digital', 'certificado', 'e-CPF', 'e-CNPJ'];
      for (const alt of certAlternatives) {
        certClicked = await clickByText(this.page, alt, 'a, button, div, span, li, label');
        if (certClicked) {
          console.log(`[Scraper] Clicou usando texto alternativo: "${alt}"`);
          break;
        }
      }
    }
    
    if (!certClicked) {
      await this.page.screenshot({ path: '/tmp/esocial_erro_certificado_nao_encontrado.png' });
      throw new Error('Opção "Seu certificado digital" não encontrada na página do gov.br');
    }
    
    console.log('[Scraper] Clicou em "Seu certificado digital". Aguardando popup/autenticação...');
    
    // ============================================
    // PASSO 4: Aguardar popup de certificado e autenticação
    // ============================================
    console.log('[Scraper] PASSO 4: Aguardando seleção automática de certificado...');
    
    // O Chrome deve mostrar popup de seleção de certificado
    // Com --auto-select-certificate-for-urls, deve selecionar automaticamente
    // Aguardar tempo suficiente para o popup aparecer e ser processado
    await sleep(8000);
    
    await this.page.screenshot({ path: '/tmp/esocial_03_apos_certificado.png' });
    
    // Tentar aguardar navegação de retorno ao eSocial
    try {
      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    } catch (e) {
      console.log('[Scraper] Timeout aguardando navegação pós-certificado');
    }
    
    await this.page.screenshot({ path: '/tmp/esocial_04_final.png' });
    
    const finalUrl = this.page.url();
    const finalTitle = await this.page.title();
    console.log('[Scraper] URL final após login:', finalUrl);
    console.log('[Scraper] Título final:', finalTitle);
    
    // ============================================
    // VERIFICAÇÃO: Login foi bem-sucedido?
    // ============================================
    
    // Ainda na página de login do eSocial = falhou
    if (finalUrl.includes('login.esocial.gov.br/login.aspx')) {
      const errorMsgs = await this.page.$$eval('.alert, .error, .msg-erro, [class*="error"], [class*="alert"]', els =>
        els.map(el => el.textContent?.trim()).filter(Boolean)
      );
      const debugInfo = {
        url: finalUrl,
        title: finalTitle,
        errorMessages: errorMsgs.slice(0, 5)
      };
      console.log('[Scraper] DEBUG - Login falhou:', JSON.stringify(debugInfo));
      throw new Error(`Login não completado. Ainda na página de login. Debug: ${JSON.stringify(debugInfo)}`);
    }
    
    // Ainda na página do gov.br sem ter logado
    if (finalUrl.includes('sso.acesso.gov.br') && !finalUrl.includes('authorize')) {
      const pageContent = await this.page.content();
      const hasLoginForm = pageContent.includes('Seu certificado') || pageContent.includes('senha');
      if (hasLoginForm) {
        throw new Error('Login não completado. Ainda na página do gov.br aguardando autenticação.');
      }
    }
    
    console.log('[Scraper] === LOGIN CONCLUÍDO COM SUCESSO ===');
  }

  async navigateToIRRF() {
    console.log('[Scraper] Navigating to IRRF por trabalhador...');
    
    try {
      // Menu: Folha de Pagamento
      let menuClicked = false;
      try {
        await this.page.waitForSelector(SELECTORS.menuFolhaPagamento, { timeout: 5000 });
        await this.page.click(SELECTORS.menuFolhaPagamento);
        menuClicked = true;
      } catch {
        menuClicked = await clickByText(this.page, 'Folha de Pagamento', 'a, button, li, span');
      }
      await sleep(1000);
      
      // Submenu: Totalizadores
      try {
        await this.page.waitForSelector(SELECTORS.submenuTotalizadores, { timeout: 5000 });
        await this.page.click(SELECTORS.submenuTotalizadores);
      } catch {
        await clickByText(this.page, 'Totalizadores', 'a, button, li, span');
      }
      await sleep(1000);
      
      // Submenu: Trabalhador
      try {
        await this.page.waitForSelector(SELECTORS.submenuTrabalhador, { timeout: 5000 });
        await this.page.click(SELECTORS.submenuTrabalhador);
      } catch {
        await clickByText(this.page, 'Trabalhador', 'a, button, li, span');
      }
      await sleep(1000);
      
      // Opção: IRRF por trabalhador
      try {
        await this.page.waitForSelector(SELECTORS.optionIRRF, { timeout: 5000 });
        await this.page.click(SELECTORS.optionIRRF);
      } catch {
        await clickByText(this.page, 'IRRF', 'a, button, li, span');
      }
      await sleep(2000);
      
      console.log('[Scraper] Navigated to IRRF form');
      await debugDumpInputs(this.page, 'irrf_form');
      
    } catch (error) {
      console.error('[Scraper] Navigation error:', error.message);
      await this.page.screenshot({ path: '/tmp/esocial_nav_error.png' });
      throw new Error(`Falha na navegação: ${error.message}`);
    }
  }

  async consultarIRRF(cpf, periodo) {
    console.log(`[Scraper] Consulting IRRF for CPF ${cpf}, period ${periodo}...`);
    
    try {
      // Limpar campos anteriores (mantém simples: limpar inputs visíveis)
      await this.page.evaluate(() => {
        const inputs = document.querySelectorAll('input');
        inputs.forEach((input) => {
          if (input.type && ['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(input.type)) return;
          try { input.value = ''; } catch {}
        });
      });

      const periodoFormatado = this.formatPeriodo(periodo);
      const cpfFormatado = this.formatCPF(cpf);

      // Encontrar campo Período (selector -> label -> fallback por posição)
      let periodoEl = await this.page.$(SELECTORS.inputPeriodo);
      if (!periodoEl) periodoEl = await findInputHandleByLabel(this.page, 'Período');
      if (!periodoEl) periodoEl = await findInputHandleByLabel(this.page, 'Periodo');
      if (!periodoEl) periodoEl = await findInputHandleByLabel(this.page, 'Compet');

      // Encontrar campo CPF (selector -> label -> fallback por posição)
      let cpfEl = await this.page.$(SELECTORS.inputCPF);
      if (!cpfEl) cpfEl = await findInputHandleByLabel(this.page, 'CPF');

      // Fallback final: usar 1º e 2º inputs de texto visíveis
      if (!periodoEl || !cpfEl) {
        const visibleTextInputs = await getVisibleTextInputs(this.page);
        if (!periodoEl) periodoEl = visibleTextInputs[0] || null;
        if (!cpfEl) cpfEl = visibleTextInputs[1] || null;
      }

      if (!periodoEl || !cpfEl) {
        await debugDumpInputs(this.page, 'irrf_missing_fields');
        throw new Error('Não foi possível localizar os campos de Período e/ou CPF no formulário');
      }

      // Preencher período (formato MM/YYYY)
      await periodoEl.click({ clickCount: 3 });
      await this.page.keyboard.type(periodoFormatado, { delay: 50 });

      // Preencher CPF (formato XXX.XXX.XXX-XX)
      await cpfEl.click({ clickCount: 3 });
      await this.page.keyboard.type(cpfFormatado, { delay: 50 });

      // Clicar em Pesquisar - tentar CSS primeiro, depois texto
      let searchClicked = false;
      try {
        const btnPesquisar = await this.page.$(SELECTORS.btnPesquisar);
        if (btnPesquisar) {
          await btnPesquisar.click();
          searchClicked = true;
        }
      } catch {}
      
      if (!searchClicked) {
        searchClicked = await clickByText(this.page, 'Pesquisar', 'button, input[type="submit"], a');
      }

      // Aguardar resultado (pode ser tabela de dados ou mensagem de sem dados)
      await sleep(3000);

      // Verificar se há mensagem de "sem dados"
      const semDados = await this.page.$(SELECTORS.msgSemDados);
      if (semDados) {
        console.log(`[Scraper] No data found for ${cpf} - ${periodo}`);
        return { cpf, periodo, success: false, message: 'Sem dados para o período' };
      }

      // Verificar se há mensagem de erro
      const erro = await this.page.$(SELECTORS.msgErro);
      if (erro) {
        const msgErro = await this.page.evaluate(el => el.textContent, erro);
        console.log(`[Scraper] Error for ${cpf} - ${periodo}: ${msgErro}`);
        return { cpf, periodo, success: false, error: msgErro };
      }

      // Tentar baixar XML
      const xmlContent = await this.downloadXML();

      if (xmlContent) {
        console.log(`[Scraper] XML downloaded for ${cpf} - ${periodo}`);
        return { cpf, periodo, success: true, xml: xmlContent };
      }

      // Se não conseguir baixar XML, extrair dados da tela
      const dadosTela = await this.extractDataFromScreen();

      return {
        cpf,
        periodo,
        success: true,
        dados: dadosTela
      };
      
    } catch (error) {
      console.error(`[Scraper] Consultation error for ${cpf} - ${periodo}:`, error.message);
      await this.page.screenshot({ path: `/tmp/esocial_error_${cpf}_${periodo}.png` });
      return { cpf, periodo, success: false, error: error.message };
    }
  }

  async downloadXML() {
    try {
      // Tentar encontrar botão de download por CSS
      let downloadButton = await this.page.$(SELECTORS.btnBaixarXML);
      
      // Se não encontrar, tentar por texto
      if (!downloadButton) {
        const clicked = await clickByText(this.page, 'Baixar XML', 'button, a');
        if (clicked) {
          await sleep(3000);
          // Ler arquivo baixado
          const files = fs.readdirSync(os.tmpdir())
            .filter(f => f.endsWith('.xml') && f.includes('S-5002'));
          
          if (files.length > 0) {
            const latestFile = files.sort().pop();
            const xmlPath = path.join(os.tmpdir(), latestFile);
            const xmlContent = fs.readFileSync(xmlPath, 'utf-8');
            fs.unlinkSync(xmlPath);
            return xmlContent;
          }
        }
        return null;
      }

      // Configurar interceptação de download
      const client = await this.page.target().createCDPSession();
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: os.tmpdir()
      });

      await downloadButton.click();
      await sleep(3000);

      // Tentar ler o arquivo XML baixado
      const files = fs.readdirSync(os.tmpdir())
        .filter(f => f.endsWith('.xml') && f.includes('S-5002'));
      
      if (files.length > 0) {
        const latestFile = files.sort().pop();
        const xmlPath = path.join(os.tmpdir(), latestFile);
        const xmlContent = fs.readFileSync(xmlPath, 'utf-8');
        fs.unlinkSync(xmlPath); // Limpar arquivo temporário
        return xmlContent;
      }

      return null;
    } catch (error) {
      console.error('[Scraper] XML download error:', error.message);
      return null;
    }
  }

  async extractDataFromScreen() {
    try {
      // Extrair dados da tabela de resultados
      const dados = await this.page.evaluate(() => {
        const result = {};
        
        // Tentar extrair de uma tabela
        const table = document.querySelector('.resultado-consulta table, .dados-irrf table');
        if (table) {
          const rows = table.querySelectorAll('tr');
          rows.forEach(row => {
            const cells = row.querySelectorAll('td, th');
            if (cells.length >= 2) {
              const label = cells[0].textContent?.trim();
              const value = cells[1].textContent?.trim();
              if (label && value) {
                result[label] = value;
              }
            }
          });
        }
        
        // Tentar extrair de campos específicos
        const campos = document.querySelectorAll('.campo-valor, .info-field');
        campos.forEach(campo => {
          const label = campo.querySelector('.label, .field-label')?.textContent?.trim();
          const value = campo.querySelector('.valor, .field-value')?.textContent?.trim();
          if (label && value) {
            result[label] = value;
          }
        });
        
        return result;
      });
      
      return dados;
    } catch (error) {
      console.error('[Scraper] Data extraction error:', error.message);
      return null;
    }
  }

  async processMultiple(cpfs, periodos) {
    const results = [];
    let loginDone = false;
    
    try {
      await this.init();
      await this.login();
      loginDone = true;
      await this.navigateToIRRF();
      
      for (const periodo of periodos) {
        for (const cpf of cpfs) {
          try {
            const result = await this.consultarIRRF(cpf, periodo);
            results.push(result);
            console.log(`[Scraper] ✓ ${cpf} - ${periodo}: ${result.success ? 'OK' : 'FALHA'}`);
            
            // Clicar em Voltar para nova consulta (se necessário)
            let voltarClicked = false;
            try {
              const btnVoltar = await this.page.$(SELECTORS.btnVoltar);
              if (btnVoltar) {
                await btnVoltar.click();
                voltarClicked = true;
              }
            } catch {}
            
            if (!voltarClicked) {
              await clickByText(this.page, 'Voltar', 'button, a');
            }
            await sleep(1000);
            
          } catch (error) {
            console.error(`[Scraper] ✗ ${cpf} - ${periodo}: ${error.message}`);
            results.push({ cpf, periodo, success: false, error: error.message });
          }
          
          // Delay entre consultas para evitar bloqueio
          await sleep(2000);
        }
      }
      
    } catch (error) {
      console.error('[Scraper] Process error:', error.message);
      if (!loginDone) {
        throw error;
      }
    }
    
    return results;
  }

  formatPeriodo(periodo) {
    // Converte YYYY-MM para MM/YYYY
    if (periodo.includes('-')) {
      const [year, month] = periodo.split('-');
      return `${month}/${year}`;
    }
    return periodo;
  }

  formatCPF(cpf) {
    // Formata CPF para XXX.XXX.XXX-XX
    const numbers = cpf.replace(/\D/g, '');
    return numbers.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  }

  async close() {
    console.log('[Scraper] Closing browser...');
    
    if (this.browser) {
      await this.browser.close();
    }
    
    // Limpar arquivo de certificado temporário
    if (this.tempCertPath && fs.existsSync(this.tempCertPath)) {
      try {
        fs.unlinkSync(this.tempCertPath);
        console.log('[Scraper] Temp certificate file removed');
      } catch (e) {
        console.log('[Scraper] Could not remove temp cert file:', e.message);
      }
    }
    
    // Limpar diretório NSS database
    if (this.tempNssDb && fs.existsSync(this.tempNssDb)) {
      try {
        fs.rmSync(this.tempNssDb, { recursive: true, force: true });
        console.log('[Scraper] Temp NSS database removed');
      } catch (e) {
        console.log('[Scraper] Could not remove temp NSS db:', e.message);
      }
    }
    
    // Limpar diretório userDataDir do Chrome
    if (this.tempUserDataDir && fs.existsSync(this.tempUserDataDir)) {
      try {
        fs.rmSync(this.tempUserDataDir, { recursive: true, force: true });
        console.log('[Scraper] Temp Chrome profile removed');
      } catch (e) {
        console.log('[Scraper] Could not remove temp Chrome profile:', e.message);
      }
    }
    
    console.log('[Scraper] Browser closed');
  }
}

module.exports = { ESocialIRRFScraper };
