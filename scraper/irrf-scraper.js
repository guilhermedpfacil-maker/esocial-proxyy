/**
 * eSocial IRRF Scraper
 *
 * Automatiza a navegação no portal eSocial para consultar IRRF por trabalhador
 * Fluxo: Folha de Pagamento > Totalizadores > Trabalhador > IRRF por trabalhador
 *
 * Usa playwright-core com clientCertificates para autenticação mTLS nativa
 * (não depende do NSS database do Chrome)
 */

const SCRAPER_VERSION = 'v2.3.0-playwright-mtls-2025';

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const os = require('os');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const SELECTORS = {
  inputPeriodo: '#periodo, input[name="periodo"], input[id*="periodo"], input[placeholder*="Período"]',
  inputCPF: '#cpf, input[name="cpf"], input[id*="cpf"], input[placeholder*="CPF"]',
};

async function clickByText(page, text, tagSelector = 'button, a, input[type="submit"]') {
  return await page.evaluate((text, tagSelector) => {
    const elements = document.querySelectorAll(tagSelector);
    for (const el of elements) {
      if (el.textContent && el.textContent.toLowerCase().includes(text.toLowerCase())) {
        el.click();
        return true;
      }
    }
    return false;
  }, text, tagSelector);
}

async function debugDumpInputs(page, label) {
  try {
    const safeLabel = String(label || 'debug').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 50);
    await page.screenshot({ path: `/tmp/esocial_${safeLabel}_${Date.now()}.png`, fullPage: true });
    const inputs = await page.$$eval('input, select, textarea', (els) =>
      els.map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          name: el.getAttribute('name') || null,
          type: el.getAttribute('type') || 'text',
          placeholder: el.getAttribute('placeholder') || null,
          isVisible: rect.width > 0 && rect.height > 0,
        };
      })
    );
    console.log(`[Scraper][Debug] Inputs (${safeLabel}) =`, JSON.stringify(inputs, null, 2));
  } catch (e) {
    console.log('[Scraper][Debug] Failed to dump inputs:', e?.message);
  }
}

async function findInputHandleByLabel(page, labelIncludes) {
  const handle = await page.evaluateHandle((labelIncludes) => {
    const needle = String(labelIncludes || '').toLowerCase();
    const matchLabel = Array.from(document.querySelectorAll('label'))
      .find((l) => (l.textContent || '').toLowerCase().includes(needle));
    if (!matchLabel) return null;

    const forId = matchLabel.getAttribute('for');
    if (forId) return document.getElementById(forId);

    const nested = matchLabel.querySelector('input, select, textarea');
    if (nested) return nested;

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
  if (!el) { await handle.dispose(); return null; }
  return el;
}

async function getVisibleTextInputs(page) {
  const candidates = await page.$$('input[type="text"], input:not([type]), input[type="tel"], input[type="search"]');
  const visible = [];
  for (const h of candidates) {
    try {
      const box = await h.boundingBox();
      const disabled = await page.evaluate(el => !!el.disabled, h);
      if (box && box.width > 0 && box.height > 0 && !disabled) visible.push(h);
    } catch { /* ignore */ }
  }
  return visible;
}

class ESocialIRRFScraper {
  constructor(certificatePfx, password) {
    this.certificatePfxBase64 = certificatePfx;
    this.password = password;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.tempCertPath = null;
    this.tempUserDataDir = null;
    this.irrfFormUrl = null;
  }

  async init() {
    console.log('[Scraper] Inicializando com Playwright + clientCertificates...');
    console.log(`[Scraper] VERSÃO: ${SCRAPER_VERSION}`);
    const timestamp = Date.now();

    const pfxBuffer = Buffer.from(this.certificatePfxBase64, 'base64');
    this.tempCertPath = path.join(os.tmpdir(), `cert_${timestamp}.pfx`);
    fs.writeFileSync(this.tempCertPath, pfxBuffer);

    this.tempUserDataDir = path.join(os.tmpdir(), `chrome_${timestamp}`);
    fs.mkdirSync(this.tempUserDataDir, { recursive: true });

    console.log('[Scraper] DISPLAY:', process.env.DISPLAY);

    this.browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080',
      ]
    });

    // clientCertificates: Playwright gerencia mTLS em proxy local — independe do NSS db do Chrome
    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      clientCertificates: [{
        origin: 'https://sso.acesso.gov.br',
        pfx: pfxBuffer,
        passphrase: this.password
      }]
    });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(30000);
    this.page.setDefaultNavigationTimeout(60000);
    this.page.on('console', msg => {
      if (msg.type() === 'error') console.log('[Browser]', msg.text());
    });

    console.log('[Scraper] ✓ Browser inicializado com certificado digital (Playwright mTLS)');
  }

  async login() {
    console.log('[Scraper] ========================================');
    console.log(`[Scraper] VERSÃO DO SCRAPER: ${SCRAPER_VERSION}`);
    console.log('[Scraper] === INICIANDO FLUXO DE LOGIN ===');
    console.log('[Scraper] ========================================');

    // ============================================
    // PASSO 1: Acessar página inicial do eSocial
    // ============================================
    console.log('[Scraper] PASSO 1: Acessando página inicial do eSocial...');
    await this.page.goto('https://login.esocial.gov.br/login.aspx', { waitUntil: 'networkidle' });
    await sleep(2000);
    await this.page.screenshot({ path: '/tmp/esocial_01_pagina_inicial.png' });
    console.log('[Scraper] Página inicial carregada. URL:', this.page.url());

    const buttons1 = await this.page.$$eval('button, a, div[role="button"]', els =>
      els.map(el => ({ tag: el.tagName, text: el.textContent?.trim().substring(0, 60), href: el.getAttribute('href') || null })).filter(e => e.text)
    );
    console.log('[Scraper] Elementos clicáveis:', JSON.stringify(buttons1.slice(0, 15), null, 2));

    // ============================================
    // PASSO 2: Clicar em link SSO (sso.acesso.gov.br)
    // ============================================
    console.log('[Scraper] PASSO 2: Procurando link SSO...');

    const allPageLinks = await this.page.$$eval('a', els =>
      els.map(el => ({
        href: el.getAttribute('href') || '',
        text: (el.textContent || '').trim().substring(0, 50),
        isSSO: (el.getAttribute('href') || '').includes('sso.acesso.gov.br') || (el.getAttribute('href') || '').includes('acesso.gov.br'),
      })).filter(l => l.href.includes('gov'))
    );
    console.log('[Scraper] Links gov.br:', JSON.stringify(allPageLinks.slice(0, 10), null, 2));

    // Estratégia 1: Link direto para SSO
    let govBrClicked = await this.page.evaluate(() => {
      const ssoLinks = Array.from(document.querySelectorAll('a')).filter(el => {
        const href = el.getAttribute('href') || '';
        return (href.includes('sso.acesso.gov.br') || (href.includes('acesso.gov.br') && !href.includes('www.gov.br')));
      });
      if (ssoLinks.length > 0) {
        const best = ssoLinks.find(el => {
          const text = (el.textContent || '').toLowerCase();
          return text.includes('entrar') || text.includes('gov.br');
        }) || ssoLinks[0];
        best.click();
        return { clicked: true, method: 'direct-sso-link', href: best.getAttribute('href') };
      }
      return null;
    });

    // Estratégia 2: URL SSO no HTML
    if (!govBrClicked) {
      const pageContent = await this.page.content();
      const ssoUrlMatches = pageContent.match(/https:\/\/sso\.acesso\.gov\.br[^"'\s]*/g) ||
                            pageContent.match(/https:\/\/acesso\.gov\.br\/authorize[^"'\s]*/g);
      if (ssoUrlMatches && ssoUrlMatches.length > 0) {
        const ssoUrl = ssoUrlMatches[0].replace(/&amp;/g, '&');
        console.log('[Scraper] PASSO 2: Navegando diretamente para SSO URL:', ssoUrl);
        await this.page.goto(ssoUrl, { waitUntil: 'networkidle', timeout: 30000 });
        govBrClicked = { clicked: true, method: 'direct-navigation', url: ssoUrl };
      }
    }

    // Estratégia 3: Container "Acesso GOV.BR"
    if (!govBrClicked) {
      govBrClicked = await this.page.evaluate(() => {
        const containers = document.querySelectorAll('div, section, aside, fieldset, article');
        for (const container of containers) {
          const headers = container.querySelectorAll('h1, h2, h3, h4, h5, h6, legend, strong, span, p');
          let isGovBrBox = false;
          for (const header of headers) {
            const text = (header.textContent || '').toLowerCase().trim();
            if (text.includes('acesso gov') || text === 'gov.br' || text.includes('acesso gov.br')) {
              const rect = container.getBoundingClientRect();
              if (rect.width < 800 && rect.height < 600 && rect.width > 100) { isGovBrBox = true; break; }
            }
          }
          if (isGovBrBox) {
            for (const link of container.querySelectorAll('a')) {
              const href = link.getAttribute('href') || '';
              if (href.includes('sso.acesso.gov.br') || (href.includes('acesso.gov.br') && !href.includes('www.gov.br'))) {
                link.click();
                return { clicked: true, method: 'container-sso-link', href };
              }
            }
            for (const btn of container.querySelectorAll('button, [role="button"]')) {
              const text = (btn.textContent || '').toLowerCase().trim();
              if (text.includes('entrar com gov')) {
                btn.click();
                return { clicked: true, method: 'container-button-fallback', text: btn.textContent?.trim() };
              }
            }
          }
        }
        return null;
      });
    }

    // Estratégia 4: Último recurso por texto
    if (!govBrClicked) {
      const textClicked = await clickByText(this.page, 'Entrar com gov.br', 'a, button');
      if (textClicked) govBrClicked = { clicked: true, method: 'text-fallback' };
    }

    if (!govBrClicked) {
      await this.page.screenshot({ path: '/tmp/esocial_erro_govbr_nao_encontrado.png' });
      throw new Error('PASSO 2 falhou: Nenhum link para SSO encontrado');
    }

    console.log('[Scraper] PASSO 2: Clicou (método:', govBrClicked.method, '). Aguardando navegação...');

    // Detectar nova aba SSO
    let newPageOpened = false;
    if (govBrClicked.method !== 'direct-navigation') {
      const newPagePromise = this.context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
      try {
        await this.page.waitForURL(url => !url.includes('login.esocial.gov.br/login.aspx'), { timeout: 15000 });
      } catch (e) {
        console.log('[Scraper] PASSO 2: Timeout na navegação, verificando nova aba...');
      }
      const newPage = await newPagePromise;
      if (newPage) {
        const newUrl = newPage.url();
        if (newUrl.includes('sso.acesso.gov.br') || newUrl.includes('acesso.gov.br')) {
          console.log('[Scraper] PASSO 2: Nova aba SSO detectada:', newUrl);
          this.page = newPage;
          await this.page.bringToFront();
          newPageOpened = true;
        }
      }
    }

    // Aguardar a página estabilizar (o /authorize redireciona para /login automaticamente)
    try {
      await this.page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch {}
    await sleep(2000);

    await this.page.screenshot({ path: '/tmp/esocial_02_pagina_apos_clique.png' });
    const urlAposClique = this.page.url();
    console.log('[Scraper] PASSO 2: URL após clique:', urlAposClique);

    const isPortalGenerico = urlAposClique.includes('www.gov.br') && !urlAposClique.includes('sso.acesso');
    if (isPortalGenerico) {
      throw new Error(`PASSO 2 FALHOU: Redirecionou para portal genérico (${urlAposClique})`);
    }

    let buttons2 = [];
    try {
      buttons2 = await this.page.$$eval('a, button, [role="button"], li, [class*="card"]', els =>
        els.map(el => ({ tag: el.tagName, text: el.textContent?.trim().substring(0, 50), classes: el.className?.substring?.(0, 30) || '' })).filter(e => e.text)
      );
    } catch (e) {
      console.log('[Scraper] PASSO 2: Aviso ao listar elementos:', e.message);
    }
    console.log('[Scraper] PASSO 2: Elementos disponíveis:', JSON.stringify(buttons2.slice(0, 15), null, 2));

    // ============================================
    // PASSO 3: Navegar para endpoint de certificado
    // NÃO clicar no elemento — navegar diretamente para /login/certificado
    // para que o Playwright acione o mTLS via proxy local automaticamente
    // ============================================
    try { await this.page.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch {}

    const urlParaCert = this.page.url();
    console.log('[Scraper] PASSO 3: URL atual (SSO login):', urlParaCert);

    // Extrair authorization_id da URL atual
    const authIdMatch = urlParaCert.match(/authorization_id=([^&]+)/);
    const authorizationId = authIdMatch ? authIdMatch[1] : null;
    console.log('[Scraper] PASSO 3: authorization_id:', authorizationId);

    // Tentar extrair href real do link "Seu certificado digital" na página
    const certLinkHref = await this.page.evaluate(() => {
      const texts = ['seu certificado digital', 'certificado digital'];
      // Prioridade: links <a> com href
      for (const a of document.querySelectorAll('a')) {
        if (texts.some(t => (a.textContent || '').toLowerCase().includes(t))) {
          const href = a.getAttribute('href');
          if (href) return href;
        }
      }
      // Botões com onclick ou data-url
      for (const btn of document.querySelectorAll('button, [role="button"], li')) {
        if (texts.some(t => (btn.textContent || '').toLowerCase().includes(t))) {
          const onclick = btn.getAttribute('onclick') || '';
          const urlMatch = onclick.match(/location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/);
          if (urlMatch) return urlMatch[1];
          const dataUrl = btn.getAttribute('data-href') || btn.getAttribute('data-url');
          if (dataUrl) return dataUrl;
        }
      }
      return null;
    }).catch(() => null);
    console.log('[Scraper] PASSO 3: href do link certificado:', certLinkHref);

    // Construir URL de destino para o endpoint mTLS
    let certNavUrl = null;
    if (certLinkHref) {
      certNavUrl = certLinkHref.startsWith('http')
        ? certLinkHref
        : `https://sso.acesso.gov.br${certLinkHref.startsWith('/') ? '' : '/'}${certLinkHref}`;
    } else if (authorizationId) {
      // URL padrão do gov.br para autenticação por certificado
      certNavUrl = `https://sso.acesso.gov.br/login/certificado?authorization_id=${authorizationId}`;
    }

    if (!certNavUrl) {
      await this.page.screenshot({ path: '/tmp/esocial_erro_sem_cert_url.png' });
      throw new Error('PASSO 3: não foi possível determinar URL do endpoint de certificado');
    }

    console.log('[Scraper] PASSO 3: Navegando diretamente para endpoint mTLS:', certNavUrl);
    await this.page.screenshot({ path: '/tmp/esocial_03_antes_cert_nav.png' });

    // Navegar — Playwright apresenta o certificado automaticamente no handshake TLS
    try {
      await this.page.goto(certNavUrl, { waitUntil: 'commit', timeout: 30000 });
    } catch (navErr) {
      // 'commit' pode lançar se a resposta for um redirect imediato — isso é esperado
      console.log('[Scraper] PASSO 3: goto retornou (pode ser redirect):', navErr.message?.substring(0, 80));
    }
    await sleep(2000);
    console.log('[Scraper] PASSO 3: URL após navegar para cert endpoint:', this.page.url());

    // ============================================
    // PASSO 4: Aguardar autenticação por certificado
    // Playwright clientCertificates apresenta o certificado automaticamente
    // no handshake TLS quando o servidor pede — sem precisar do NSS db
    // ============================================
    console.log('[Scraper] PASSO 4: Aguardando Playwright apresentar certificado automaticamente...');
    await this.page.screenshot({ path: '/tmp/esocial_04a_apos_cert_click.png' });

    const loginStartTime = Date.now();
    const maxWaitMs = 90000;
    let loginCompleted = false;
    let lastUrl = this.page.url();
    let screenshotIdx = 0;

    while (Date.now() - loginStartTime < maxWaitMs) {
      await sleep(3000);

      const currentUrl = this.page.url();
      const elapsedSec = Math.round((Date.now() - loginStartTime) / 1000);
      console.log(`[Scraper] PASSO 4 - ${elapsedSec}s: ${currentUrl}`);

      if (screenshotIdx < 10) {
        await this.page.screenshot({ path: `/tmp/esocial_p4_${screenshotIdx}_${elapsedSec}s.png` }).catch(() => {});
        screenshotIdx++;
      }

      const aindaNoLogin = currentUrl.includes('login.esocial.gov.br/login.aspx') ||
                           currentUrl.includes('sso.acesso.gov.br/login') ||
                           currentUrl.includes('sso.acesso.gov.br/authorize');
      if (!aindaNoLogin) {
        console.log('[Scraper] PASSO 4: ✓ Saiu do login! URL:', currentUrl);
        loginCompleted = true;
        break;
      }

      if (currentUrl !== lastUrl) {
        console.log(`[Scraper] PASSO 4: URL mudou → ${currentUrl}`);
        lastUrl = currentUrl;
      }

      // Log do conteúdo da página para diagnóstico
      try {
        const bodyText = await this.page.evaluate(() => document.body?.innerText?.substring(0, 300) || '');
        if (bodyText) console.log('[Scraper] PASSO 4 - Conteúdo:\n', bodyText.replace(/\n+/g, ' | '));
      } catch {}
    }

    await this.page.screenshot({ path: '/tmp/esocial_04_final.png' });

    const finalUrl = this.page.url();
    const finalTitle = await this.page.title();
    console.log('[Scraper] URL final após login:', finalUrl);
    console.log('[Scraper] Título final:', finalTitle);

    if (finalUrl.includes('login.esocial.gov.br/login.aspx')) {
      const errorMsgs = await this.page.$$eval('.alert, .error, .msg-erro, [class*="error"], [class*="alert"]',
        els => els.map(el => el.textContent?.trim()).filter(Boolean)
      );
      throw new Error(`Login não completado. Ainda na página de login. Erros: ${JSON.stringify(errorMsgs.slice(0, 3))}`);
    }

    if (finalUrl.includes('sso.acesso.gov.br') && !finalUrl.includes('authorize')) {
      const pageContent = await this.page.content();
      if (pageContent.includes('Seu certificado') || pageContent.includes('senha')) {
        throw new Error('Login não completado. Ainda na página do gov.br aguardando autenticação.');
      }
    }

    console.log('[Scraper] === LOGIN CONCLUÍDO COM SUCESSO ===');
  }

  async navigateToIRRF() {
    console.log('[Scraper] Navegando para IRRF por trabalhador...');

    const clickMenuItem = async (texts, stepName) => {
      for (const text of texts) {
        const clicked = await this.page.evaluate((text) => {
          const candidates = Array.from(document.querySelectorAll('a, button, li, span, div[role="menuitem"]'));
          const match = candidates.find(el => {
            const t = (el.textContent || '').trim().toLowerCase();
            const rect = el.getBoundingClientRect();
            return t.includes(text.toLowerCase()) && rect.width > 0 && rect.height > 0;
          });
          if (match) { match.click(); return true; }
          return false;
        }, text);
        if (clicked) { console.log(`[Scraper] ${stepName}: clicou em "${text}"`); return true; }
      }
      return false;
    };

    try {
      await this.page.screenshot({ path: '/tmp/esocial_nav_00_logado.png' });

      const fp = await clickMenuItem(['Folha de Pagamento', 'Folha Pagamento', 'Folha'], 'Menu Folha');
      if (!fp) throw new Error('Menu "Folha de Pagamento" não encontrado');
      await sleep(1500);
      await this.page.screenshot({ path: '/tmp/esocial_nav_01_folha.png' });

      const tot = await clickMenuItem(['Totalizadores', 'Totalizador'], 'Submenu Totalizadores');
      if (!tot) throw new Error('Submenu "Totalizadores" não encontrado');
      await sleep(1500);
      await this.page.screenshot({ path: '/tmp/esocial_nav_02_totalizadores.png' });

      const trab = await clickMenuItem(['Trabalhador'], 'Submenu Trabalhador');
      if (!trab) throw new Error('Submenu "Trabalhador" não encontrado');
      await sleep(1500);
      await this.page.screenshot({ path: '/tmp/esocial_nav_03_trabalhador.png' });

      const irrf = await clickMenuItem(['IRRF por Trabalhador', 'IRRF por trabalhador', 'IRRF'], 'Opção IRRF');
      if (!irrf) throw new Error('Opção "IRRF por Trabalhador" não encontrada');
      await sleep(2000);
      await this.page.screenshot({ path: '/tmp/esocial_nav_04_irrf.png' });

      await this.page.waitForFunction(() => document.querySelectorAll('input').length > 0, { timeout: 15000 });
      this.irrfFormUrl = this.page.url();
      console.log(`[Scraper] Formulário IRRF carregado. URL: ${this.irrfFormUrl}`);
      await debugDumpInputs(this.page, 'irrf_form');

    } catch (error) {
      await this.page.screenshot({ path: '/tmp/esocial_nav_error.png' });
      throw new Error(`Falha na navegação ao menu IRRF: ${error.message}`);
    }
  }

  async voltarAoFormulario() {
    const voltarClicked = await this.page.evaluate(() => {
      const voltar = Array.from(document.querySelectorAll('button, a')).find(el => {
        const t = (el.textContent || '').trim().toLowerCase();
        return t === 'voltar' || t.includes('nova consulta') || t.includes('nova pesquisa');
      });
      if (voltar) { voltar.click(); return true; }
      return false;
    });

    if (voltarClicked) { await sleep(1500); return; }

    if (this.irrfFormUrl) {
      await this.page.goto(this.irrfFormUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await sleep(1500);
      return;
    }

    await this.navigateToIRRF();
  }

  async consultarIRRF(cpf, periodo) {
    const cpfClean = cpf.replace(/\D/g, '');
    const periodoFormatado = this.formatPeriodo(periodo);
    const cpfFormatado = this.formatCPF(cpf);
    console.log(`[Scraper] Consultando CPF ${cpfFormatado} - Período ${periodoFormatado}...`);

    try {
      await this.page.evaluate(() => {
        const skip = new Set(['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image']);
        document.querySelectorAll('input').forEach(el => {
          if (!skip.has((el.type || '').toLowerCase())) { try { el.value = ''; } catch {} }
        });
      });

      let periodoEl = await this.page.$(SELECTORS.inputPeriodo);
      if (!periodoEl) periodoEl = await findInputHandleByLabel(this.page, 'Período');
      if (!periodoEl) periodoEl = await findInputHandleByLabel(this.page, 'Periodo');
      if (!periodoEl) periodoEl = await findInputHandleByLabel(this.page, 'Compet');
      if (!periodoEl) periodoEl = await findInputHandleByLabel(this.page, 'Mês');

      let cpfEl = await this.page.$(SELECTORS.inputCPF);
      if (!cpfEl) cpfEl = await findInputHandleByLabel(this.page, 'CPF');
      if (!cpfEl) cpfEl = await findInputHandleByLabel(this.page, 'Trabalhador');

      if (!periodoEl || !cpfEl) {
        const visibles = await getVisibleTextInputs(this.page);
        if (!periodoEl) periodoEl = visibles[0] || null;
        if (!cpfEl)     cpfEl     = visibles[1] || null;
      }

      if (!periodoEl || !cpfEl) {
        await debugDumpInputs(this.page, `missing_fields_${cpfClean}_${periodo}`);
        throw new Error('Campos de Período e/ou CPF não encontrados no formulário');
      }

      await periodoEl.click({ clickCount: 3 });
      await periodoEl.type(periodoFormatado, { delay: 60 });

      await cpfEl.click({ clickCount: 3 });
      await cpfEl.type(cpfFormatado, { delay: 60 });

      await this.page.screenshot({ path: `/tmp/esocial_consulta_${cpfClean}_preenchido.png` });

      const searchClicked = await this.page.evaluate(() => {
        const texts = ['pesquisar', 'consultar', 'buscar', 'pesquisa', 'search'];
        const match = Array.from(document.querySelectorAll('button, input[type="submit"], a')).find(el => {
          const t = (el.textContent || el.value || '').trim().toLowerCase();
          return texts.some(s => t.includes(s));
        });
        if (match) { match.click(); return true; }
        return false;
      });

      if (!searchClicked) await cpfEl.press('Enter');

      await sleep(3000);
      await this.page.screenshot({ path: `/tmp/esocial_consulta_${cpfClean}_resultado.png` });

      const paginaTexto = await this.page.evaluate(() => document.body?.innerText || '');
      const semDadosTextos = ['sem dados', 'nenhum registro', 'não encontrado', 'nao encontrado', 'no records', 'no data'];
      if (semDadosTextos.some(t => paginaTexto.toLowerCase().includes(t))) {
        console.log(`[Scraper] Sem dados para CPF ${cpfFormatado} - ${periodoFormatado}`);
        return { cpf, periodo, success: false, message: 'Sem dados para o período informado' };
      }

      const xmlContent = await this.downloadXML();
      if (xmlContent) {
        console.log(`[Scraper] XML baixado com sucesso para ${cpfFormatado} - ${periodoFormatado} (${xmlContent.length} bytes)`);
        return { cpf, periodo, success: true, xml: xmlContent };
      }

      const dadosTela = await this.extractDataFromScreen();
      const temDados = dadosTela && Object.keys(dadosTela).length > 0;
      return { cpf, periodo, success: temDados, dados: dadosTela, message: temDados ? 'Dados extraídos da tela (XML não disponível)' : 'Nenhum dado encontrado' };

    } catch (error) {
      console.error(`[Scraper] Erro na consulta ${cpf} - ${periodo}:`, error.message);
      await this.page.screenshot({ path: `/tmp/esocial_erro_${cpfClean}_${periodo}.png` });
      return { cpf, periodo, success: false, error: error.message };
    }
  }

  async downloadXML() {
    const downloadDir = path.join(os.tmpdir(), `esocial_dl_${Date.now()}`);
    fs.mkdirSync(downloadDir, { recursive: true });

    try {
      const client = await this.context.newCDPSession(this.page);
      await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

      const downloadTexts = ['Baixar XML', 'Download XML', 'XML', 'Baixar', 'Download', 'baixar xml', 'download xml', 'xml', 'baixar', 'download'];
      let downloadClicked = false;

      for (const text of downloadTexts) {
        const clicked = await this.page.evaluate((text) => {
          const match = Array.from(document.querySelectorAll('button, a, input[type="button"]')).find(el => {
            const t = (el.textContent || el.value || '').trim().toLowerCase();
            const rect = el.getBoundingClientRect();
            return t.includes(text.toLowerCase()) && rect.width > 0 && rect.height > 0;
          });
          if (match) { match.click(); return true; }
          return false;
        }, text);
        if (clicked) { console.log(`[Scraper] Download: clicou em "${text}"`); downloadClicked = true; break; }
      }

      if (!downloadClicked) {
        downloadClicked = await this.page.evaluate(() => {
          const match = Array.from(document.querySelectorAll('a[href]')).find(a => {
            const href = (a.getAttribute('href') || '').toLowerCase();
            return href.includes('xml') || href.includes('download');
          });
          if (match) { match.click(); return true; }
          return false;
        });
        if (downloadClicked) console.log('[Scraper] Download: clicou em link com href xml/download');
      }

      if (!downloadClicked) {
        console.log('[Scraper] Download: nenhum botão de download XML encontrado');
        fs.rmSync(downloadDir, { recursive: true, force: true });
        return null;
      }

      const maxWaitMs = 20000;
      const startTime = Date.now();
      while (Date.now() - startTime < maxWaitMs) {
        await sleep(500);
        let files;
        try { files = fs.readdirSync(downloadDir); } catch { continue; }
        const completed = files.filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
        const inProgress = files.filter(f => f.endsWith('.crdownload'));
        if (completed.length > 0 && inProgress.length === 0) {
          const xmlFiles = completed.filter(f => f.toLowerCase().endsWith('.xml'));
          const target = xmlFiles[0] || completed[0];
          try {
            const content = fs.readFileSync(path.join(downloadDir, target), 'utf-8');
            console.log(`[Scraper] Download: arquivo "${target}" lido (${content.length} bytes)`);
            fs.rmSync(downloadDir, { recursive: true, force: true });
            return content;
          } catch (readErr) {
            console.log('[Scraper] Download: erro ao ler arquivo:', readErr.message);
          }
        }
      }

      console.log('[Scraper] Download: timeout aguardando arquivo');
      fs.rmSync(downloadDir, { recursive: true, force: true });
      return null;

    } catch (error) {
      console.error('[Scraper] Erro no download XML:', error.message);
      try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch {}
      return null;
    }
  }

  async extractDataFromScreen() {
    try {
      return await this.page.evaluate(() => {
        const result = {};
        const table = document.querySelector('.resultado-consulta table, .dados-irrf table');
        if (table) {
          table.querySelectorAll('tr').forEach(row => {
            const cells = row.querySelectorAll('td, th');
            if (cells.length >= 2) {
              const label = cells[0].textContent?.trim();
              const value = cells[1].textContent?.trim();
              if (label && value) result[label] = value;
            }
          });
        }
        document.querySelectorAll('.campo-valor, .info-field').forEach(campo => {
          const label = campo.querySelector('.label, .field-label')?.textContent?.trim();
          const value = campo.querySelector('.valor, .field-value')?.textContent?.trim();
          if (label && value) result[label] = value;
        });
        return result;
      });
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

      const total = cpfs.length * periodos.length;
      let done = 0;

      for (const periodo of periodos) {
        for (const cpf of cpfs) {
          done++;
          console.log(`[Scraper] [${done}/${total}] Consultando CPF ${cpf} - Período ${periodo}...`);
          try {
            const result = await this.consultarIRRF(cpf, periodo);
            results.push(result);
            console.log(`[Scraper] [${done}/${total}] ${result.success ? '✓ OK' : '✗ FALHA'}: ${cpf} - ${periodo}`);
          } catch (error) {
            console.error(`[Scraper] [${done}/${total}] ✗ ERRO: ${cpf} - ${periodo}: ${error.message}`);
            results.push({ cpf, periodo, success: false, error: error.message });
          }

          if (done < total) {
            try { await this.voltarAoFormulario(); } catch (navErr) {
              console.log('[Scraper] Aviso ao voltar ao formulário:', navErr.message);
            }
            await sleep(1500);
          }
        }
      }

    } catch (error) {
      console.error('[Scraper] Erro geral:', error.message);
      if (!loginDone) throw error;
    }

    return results;
  }

  formatPeriodo(periodo) {
    if (periodo.includes('-')) {
      const [year, month] = periodo.split('-');
      return `${month}/${year}`;
    }
    return periodo;
  }

  formatCPF(cpf) {
    const numbers = cpf.replace(/\D/g, '');
    return numbers.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  }

  async close() {
    console.log('[Scraper] Fechando browser...');
    try { if (this.context) await this.context.close(); } catch {}
    try { if (this.browser) await this.browser.close(); } catch {}

    if (this.tempCertPath) { try { fs.unlinkSync(this.tempCertPath); } catch {} }
    if (this.tempUserDataDir) { try { fs.rmSync(this.tempUserDataDir, { recursive: true, force: true }); } catch {} }

    console.log('[Scraper] Browser fechado');
  }
}

module.exports = { ESocialIRRFScraper };
