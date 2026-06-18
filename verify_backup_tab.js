const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('http://localhost:9090/login.html');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: '/tmp/v1_login.png' });

  const inputs = await page.$$('input');
  console.log('Inputs en login:', inputs.length);
  for (const inp of inputs) {
    const type = await inp.getAttribute('type');
    const id   = await inp.getAttribute('id');
    console.log(' -', type, id);
  }

  // Intentar llenar usuario y contraseña
  await page.fill('input[type="text"], input:not([type="password"])', 'admin').catch(() => {});
  await page.fill('input[type="password"]', 'cambia_esto_por_una_contraseña_fuerte');
  await page.click('button[type="submit"], button.login-btn, form button').catch(() => page.keyboard.press('Enter'));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/v2_after_login.png' });
  console.log('URL después del login:', page.url());

  // Ir a admin
  await page.goto('http://localhost:9090/admin.html');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: '/tmp/v3_admin.png' });
  console.log('URL admin:', page.url());

  // Hacer clic en tab Respaldos
  const respaldosBtn = await page.$('[data-tab="respaldos"]');
  console.log('Tab Respaldos encontrado:', !!respaldosBtn);
  if (respaldosBtn) {
    await respaldosBtn.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: '/tmp/v4_respaldos_tab.png' });

    const panel = await page.$('#tab-respaldos');
    const isVisible = panel ? await panel.isVisible() : false;
    console.log('Panel respaldos visible:', isVisible);

    const btn = await page.$('#btnRunBackup');
    const btnVisible = btn ? await btn.isVisible() : false;
    console.log('Botón crear respaldo visible:', btnVisible);
  }

  await browser.close();
})();
