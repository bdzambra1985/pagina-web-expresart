'use strict';

const CALLMEBOT_PHONE  = process.env.CALLMEBOT_PHONE;
const CALLMEBOT_APIKEY = process.env.CALLMEBOT_APIKEY;

function notifyWhatsApp(text) {
    if (!CALLMEBOT_PHONE || !CALLMEBOT_APIKEY) return;
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(CALLMEBOT_PHONE)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(CALLMEBOT_APIKEY)}`;
    fetch(url).catch(e => console.error('[CallMeBot]', e.message));
}

module.exports = { notifyWhatsApp };
