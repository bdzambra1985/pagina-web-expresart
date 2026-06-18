const { chromium } = require('playwright');
const BASE = 'https://pagina-web-expresart-production.up.railway.app';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Login
  await page.goto(BASE + '/login.html');
  await page.waitForLoadState('networkidle');
  await page.fill('input[type="password"]', 'expresart2025');
  await page.fill('input[type="text"]', 'admin');
  await page.click('button[type="submit"], button.login-btn, form button');
  await page.waitForTimeout(3000);
  console.log('URL después del login:', page.url());
  await page.screenshot({ path: '/tmp/prod_1_login.png' });

  // Ir al admin
  await page.goto(BASE + '/admin.html');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: '/tmp/prod_2_admin.png' });

  // Click en tab Respaldos
  const respaldosBtn = await page.$('[data-tab="respaldos"]');
  console.log('Tab Respaldos encontrado:', !!respaldosBtn);
  if (respaldosBtn) {
    await respaldosBtn.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: '/tmp/prod_3_respaldos.png' });

    const panel = await page.$('#tab-respaldos');
    console.log('Panel visible:', panel ? await panel.isVisible() : false);

    const btnBackup = await page.$('#btnRunBackup');
    console.log('Botón backup visible:', btnBackup ? await btnBackup.isVisible() : false);

    // Hacer clic en "Crear respaldo ahora"
    if (btnBackup && await btnBackup.isVisible()) {
      await btnBackup.click();
      await page.waitForTimeout(5000);
      await page.screenshot({ path: '/tmp/prod_4_after_backup.png' });
      const status = await page.$('#backupStatus');
      const statusText = status ? await status.innerText() : '';
      console.log('Estado del backup:', statusText);
    }
  }

  await browser.close();
})();
