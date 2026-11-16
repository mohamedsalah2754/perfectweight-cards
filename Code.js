/*
 * بطاقات الخصم الإلكترونية | الوزن المثالي
 * HTML + Google Sheets API ONLY (NO Apps Script)
 *
 * الإعداد مرة واحدة (يمكن بدلاً من ذلك استخدام إعدادات الصفحة):
 * 1. أنشئ Spreadsheet جديدًا في Google Sheets.
 * 2. فعّل Google Sheets API في مشروع Google Cloud.
 * 3. أعدّ OAuth consent screen وأنشئ OAuth client type "Web application".
 * 4. أضف أصل موقع HTTPS الذي يستضيف index.html إلى Authorized JavaScript origins.
 * 5. أدخل القيم بالأسفل وارفع index.html وCode.js بجوار بعضهما على HTTPS.
 * 6. امنح حسابات الموظفين صلاحية تعديل الشيت.
 *
 * ليس هناك client_secret داخل الكود. OAuth access token في الذاكرة فقط.
 */
const CONFIG = {
  googleClientId: '',          // Google OAuth Web Client ID
  spreadsheetId: '',           // Google Sheets spreadsheet ID
  sheetTab: 'Cards',
  companyName: 'الوزن المثالي',
  logoUrl: ''                  // اختياري: رابط HTTPS للشعار الرسمي، ليس مطلوبًا
};

(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const HEADERS = ['تاريخ الإصدار', 'رقم البطاقة', 'اسم العميل', 'رقم الجوال', 'الفرع', 'الخصم', 'تاريخ الانتهاء', 'الحالة', 'رابط البطاقة'];
  const BASE_API = 'https://sheets.googleapis.com/v4/spreadsheets/';
  const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';
  let accessToken = null;
  let tokenClient = null;
  let currentCardLink = '';
  let settings = loadSettings();
  let lastStage = 'بدء التشغيل';

  function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('pwSheetsSettings') || '{}'); } catch (_) {}
    return {
      clientId: CONFIG.googleClientId || saved.clientId || '',
      sheetId: CONFIG.spreadsheetId || saved.sheetId || ''
    };
  }

  function message(txt, kind='info') {
    const el = $('appStatus');
    el.textContent = txt;
    el.className = 'status visible ' + kind;
  }

  // حوّل أخطاء OAuth وGoogle API إلى رسالة واضحة بدل كلمة «فشل» فقط.
  function explainError(err) {
    const raw = String(err?.message || err || 'خطأ غير معروف');
    const lower = raw.toLowerCase();
    if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('load failed'))
      return 'تعذر الاتصال بخوادم Google. تأكد من الإنترنت، وافتح الموقع برابط HTTPS، ثم جرّب متصفح Chrome أو Safari بدون مانع إعلانات. (' + raw + ')';
    if (lower.includes('origin_mismatch') || lower.includes('not a valid origin') || lower.includes('invalid_origin'))
      return 'عنوان الموقع غير مضاف في Google Cloud > OAuth Client > Authorized JavaScript origins. أضف أصل الموقع فقط مثل https://USERNAME.github.io . (' + raw + ')';
    if (lower.includes('access_denied') || lower.includes('unauthorized_client') || lower.includes('invalid_client'))
      return 'تحقق من OAuth Client ID وأن حسابك موجود في Test users إذا كان التطبيق في وضع الاختبار. (' + raw + ')';
    if (lower.includes('popup_closed') || lower.includes('popup_failed_to_open'))
      return 'نافذة تسجيل دخول Google أُغلقت أو منعها المتصفح. اسمح بالنوافذ المنبثقة لهذا الموقع. (' + raw + ')';
    if (lower.includes('(403)'))
      return 'Google رفض الوصول (403). فعّل Google Sheets API وتأكد أن الحساب الذي سجلت به لديه صلاحية تعديل الشيت. (' + raw + ')';
    if (lower.includes('(404)'))
      return 'لم يعثر Google على الشيت (404). راجع Spreadsheet ID وصلاحيات حساب Google. (' + raw + ')';
    if (lower.includes('(401)'))
      return 'انتهى تسجيل الدخول (401). اضغط «ربط حساب Google» مرة أخرى. (' + raw + ')';
    return raw;
  }

  function phoneValid(s) {
    const normalized = s.replace(/[\s()\-]/g, '');
    return /^\+?\d{9,15}$/.test(normalized);
  }

  function utf8ToBase64Url(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
  }
  function base64UrlToUtf8(str) {
    if (!/^[A-Za-z0-9_-]+$/.test(str) || str.length > 7000) throw new Error('رابط البطاقة غير صالح.');
    const raw = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4));
    return new TextDecoder().decode(Uint8Array.from(raw, ch => ch.charCodeAt(0)));
  }

  function randomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = new Uint8Array(10);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, x => alphabet[x % alphabet.length]).join('');
  }

  function todayPlus(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }

  function getSettings() {
    if (!settings.clientId || !/\.apps\.googleusercontent\.com$/.test(settings.clientId)) {
      $('settingsPanel').open = true;
      throw new Error('أدخل Google OAuth Client ID الصحيح في إعدادات الاتصال أولًا.');
    }
    if (!settings.sheetId || !/^[a-zA-Z0-9_-]{20,}$/.test(settings.sheetId)) {
      $('settingsPanel').open = true;
      throw new Error('أدخل Spreadsheet ID من رابط Google Sheets أولًا.');
    }
    return settings;
  }

  function buildUrl(card) {
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      throw new Error('ارفع الموقع على عنوان HTTPS قبل إنشاء روابط QR تعمل على جوال العميل.');
    }
    const root = location.href.split('#')[0].split('?')[0];
    return root + '#card=' + utf8ToBase64Url(JSON.stringify(card));
  }

  function saveSettings() {
    const clientId = $('clientId').value.trim();
    const sheetIdRaw = $('sheetId').value.trim();
    const sheetId = (sheetIdRaw.match(/\/spreadsheets\/d\/([\w-]+)/) || [])[1] || sheetIdRaw;
    settings = {clientId, sheetId};
    localStorage.setItem('pwSheetsSettings', JSON.stringify(settings));
    accessToken = null;
    tokenClient = null;
    $('testBtn').disabled = true;
    $('loginStatus').textContent = 'غير متصل — اربط الحساب مجددًا';
    message('تم حفظ الإعدادات على هذا الجهاز. اربط حساب Google قبل إنشاء البطاقة.', 'ok');
  }

  async function login() {
    try {
      getSettings();
      if (location.protocol !== 'https:' && location.hostname !== 'localhost') throw new Error('OAuth لا يعمل عند فتح ملف HTML مباشرة. انشره على HTTPS أولًا.');
      if (!window.google?.accounts?.oauth2) throw new Error('تعذر تحميل مكتبة Google. تأكد من اتصال الإنترنت وأعد فتح الصفحة.');
      $('loginBtn').disabled = true;
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: settings.clientId,
        scope: SCOPES,
        callback: response => {
          $('loginBtn').disabled = false;
          if (response.error || !response.access_token) {
            message('لم يكتمل تسجيل الدخول: ' + explainError(response.error_description || response.error || 'غير معروف'), 'err');
            return;
          }
          accessToken = response.access_token;
          $('testBtn').disabled = false;
          $('loginStatus').textContent = 'متصل بحساب Google';
          $('loginBtn').textContent = 'تجديد تسجيل الدخول';
          message('تم الربط. يمكنك الآن إصدار بطاقة وحفظها في الشيت.', 'ok');
        },
        error_callback: err => {
          $('loginBtn').disabled = false;
          message('تعذر تسجيل الدخول: ' + explainError(err?.type || 'غير معروف'), 'err');
        }
      });
      tokenClient.requestAccessToken({prompt:'consent'});
    } catch (e) {
      $('loginBtn').disabled = false;
      message(explainError(e), 'err');
    }
  }

  async function api(url, options={}) {
    if (!accessToken) throw new Error('اضغط «ربط حساب Google» أولًا.');
    let res;
    try { res = await fetch(url, {
      ...options,
      headers: {
        Authorization: 'Bearer ' + accessToken,
        ...(options.body ? {'Content-Type':'application/json'} : {}),
        ...(options.headers || {})
      }
    }); } catch (e) { throw new Error('تعذر إجراء طلب Google API: ' + (e?.message || e)); }
    let data;
    try {data = await res.json();} catch (_) {data = {};}
    if (!res.ok) {
      if (res.status === 401) {
        accessToken = null;
        $('testBtn').disabled = true;
        $('loginStatus').textContent = 'انتهت الجلسة — أعد الربط';
      }
      const cause = data?.error?.message || res.statusText || 'خطأ غير معروف';
      throw new Error(`Google Sheets API (${res.status}): ${cause}`);
    }
    return data;
  }

  function rangeUrl(range) {
    return BASE_API + encodeURIComponent(settings.sheetId) + '/values/' + encodeURIComponent(range);
  }

  async function testConnection() {
    try {
      getSettings();
      if (!accessToken) throw new Error('اضغط «ربط حساب Google» أولًا.');
      $('testBtn').disabled = true;
      message('جارٍ اختبار الوصول إلى الشيت...', 'info');
      const data = await api(BASE_API + encodeURIComponent(settings.sheetId) + '?fields=properties(title),sheets(properties(title))');
      const title = data.properties?.title || 'الشيت';
      message('نجح الربط بالشيت «' + title + '». يمكنك الآن إصدار بطاقة تجريبية.', 'ok');
    } catch (err) {
      message('اختبار الاتصال: ' + explainError(err), 'err');
    } finally {
      $('testBtn').disabled = !accessToken;
    }
  }

  async function ensureCardTab() {
    const id = encodeURIComponent(settings.sheetId);
    const metadata = await api(BASE_API + id + '?fields=sheets(properties(title))');
    if (!(metadata.sheets || []).some(s => s.properties?.title === CONFIG.sheetTab)) {
      await api(BASE_API + id + ':batchUpdate', {
        method:'POST',
        body:JSON.stringify({requests:[{addSheet:{properties:{title:CONFIG.sheetTab}}}]})
      });
    }
    const row1 = await api(rangeUrl(`'${CONFIG.sheetTab}'!A1:I1`));
    if (!row1.values?.[0]?.length) {
      await api(rangeUrl(`'${CONFIG.sheetTab}'!A1:I1`) + '?valueInputOption=RAW', {
        method:'PUT', body:JSON.stringify({values:[HEADERS]})
      });
    } else if (row1.values[0][0] !== HEADERS[0]) {
      throw new Error('تبويب Cards يحتوي على بيانات مختلفة؛ استخدم شيت جديدًا أو غيّر اسم التبويب في Code.js.');
    }
  }

  async function appendCard(card, url) {
    const timestamp = new Date().toLocaleString('en-GB', {timeZone:'Asia/Riyadh', hour12:false});
    const values = [[timestamp,card.code,card.name,card.phone,card.branch,card.discount,card.expiry,'صادرة',url]];
    const urlAPI = rangeUrl(`'${CONFIG.sheetTab}'!A:I`) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
    await api(urlAPI,{method:'POST', body:JSON.stringify({values})});
  }

  function issueQr(link, code) {
    $('qrCode').replaceChildren();
    if (typeof QRCode !== 'function') {
      $('result').classList.remove('visible');
      message('تم حفظ البطاقة، لكن مكتبة QR لم تُحمّل. انسخ الرابط بدلًا من ذلك: ' + link, 'info');
      return;
    }
    try {
      new QRCode($('qrCode'), {text:link,width:240,height:240,colorDark:'#153d30',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.L});
      $('issuedCode').textContent = 'رقم البطاقة: ' + code;
      $('cardUrl').textContent = link;
      currentCardLink = link;
      $('result').classList.add('visible');
      $('result').scrollIntoView({behavior:'smooth',block:'nearest'});
    } catch (_) {
      $('result').classList.remove('visible');
      message('تم حفظ البطاقة لكن تعذّر رسم QR. رابط البطاقة: ' + link, 'info');
    }
  }

  async function issue(event) {
    event.preventDefault();
    $('result').classList.remove('visible');
    try {
      getSettings();
      if (!accessToken) throw new Error('لازم تربط حساب Google أولًا.');
      const name = $('customerName').value.trim();
      const phone = $('customerPhone').value.trim();
      const branch = $('branch').value;
      const discount = $('discount').value.trim();
      const expiry = $('expiry').value;
      if (!name || !phoneValid(phone) || !branch || !discount || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw new Error('تأكد من الاسم ورقم الجوال والفرع والعرض وتاريخ الانتهاء.');
      if (expiry < todayPlus(0)) throw new Error('تاريخ الصلاحية لا يمكن أن يكون في الماضي.');
      if (!$('customerConsent').checked) throw new Error('يلزم تأكيد موافقة العميل قبل إصدار البطاقة.');
      const card = {v:1,code:randomCode(),name,phone,branch,discount,expiry};
      const link = buildUrl(card);
      $('createBtn').disabled = true;
      $('createBtn').textContent = 'جارٍ الحفظ في Google Sheets…';
      message('يتم حفظ بيانات البطاقة في الشيت…');
      lastStage = 'فتح أو إنشاء تبويب Cards';
      await ensureCardTab();
      lastStage = 'تسجيل البطاقة في الشيت';
      await appendCard(card,link);
      lastStage = 'توليد QR';
      message('تم حفظ البطاقة في Google Sheets بنجاح.', 'ok');
      issueQr(link,card.code);
    } catch (error) { message('تعذر الإكمال عند خطوة «' + lastStage + '»: ' + explainError(error), 'err'); }
    finally { $('createBtn').disabled = false; $('createBtn').textContent = 'حفظ في الشيت وإنشاء QR'; }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(currentCardLink);
      $('copyBtn').textContent = 'تم نسخ الرابط ✓';
    } catch (_) {
      $('cardUrl').textContent = currentCardLink;
      message('تعذر النسخ التلقائي؛ انسخ الرابط المعروض أسفل QR.', 'info');
    }
  }

  function roundRect(ctx,x,y,w,h,r,color) {
    ctx.beginPath(); ctx.roundRect(x,y,w,h,r); ctx.fillStyle=color; ctx.fill();
  }
  function text(ctx,value,x,y,size,color,weight='normal',width=820) {
    ctx.fillStyle=color;
    ctx.font=`${weight} ${size}px Tahoma, Arial, sans-serif`;
    ctx.textAlign='right';
    ctx.direction='rtl';
    while (ctx.measureText(String(value)).width > width && size > 26) {
      size -= 2; ctx.font=`${weight} ${size}px Tahoma, Arial, sans-serif`;
    }
    ctx.fillText(String(value),x,y);
  }
  function formatExpiry(s) {
    const [y,m,d] = s.split('-');
    return `${d}/${m}/${y}`;
  }

  function cardToImage(card) {
    const c = document.createElement('canvas');
    c.width=1080; c.height=1780;
    const ctx = c.getContext('2d');
    ctx.fillStyle='#eff4ef'; ctx.fillRect(0,0,1080,1780);
    const grd=ctx.createLinearGradient(0,0,1080,720);
    grd.addColorStop(0,'#0a503d'); grd.addColorStop(1,'#07372f');
    ctx.fillStyle=grd; ctx.fillRect(0,0,1080,600);
    ctx.fillStyle='#ddbd78'; ctx.beginPath();ctx.arc(125,80,215,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#0a503d'; ctx.beginPath();ctx.arc(125,80,186,0,Math.PI*2);ctx.fill();
    roundRect(ctx,70,95,940,1560,38,'#ffffff');
    roundRect(ctx,70,95,940,332,38,'#0c4a3b');
    roundRect(ctx,120,140,115,115,24,'#ffffff');
    ctx.fillStyle='#0d5b44'; ctx.font='bold 47px Tahoma, Arial, sans-serif';ctx.textAlign='center';ctx.direction='ltr';ctx.fillText('PW',177,213);
    text(ctx,CONFIG.companyName,937,198,60,'#ffffff','bold',620);
    text(ctx,'بطاقة خصم إلكترونية',934,284,36,'#e3cf9b','bold',750);
    roundRect(ctx,120,458,840,155,20,'#f4f8f5');
    text(ctx,'اسم العميل',903,504,27,'#677c70');
    text(ctx,card.name,903,565,53,'#153f30','bold',770);
    roundRect(ctx,120,643,840,155,20,'#f4f8f5');
    text(ctx,'رقم الجوال',903,689,27,'#677c70');
    text(ctx,card.phone,903,752,48,'#153f30','bold',770);
    roundRect(ctx,120,830,840,155,20,'#f4f8f5');
    text(ctx,'الفرع',903,876,27,'#677c70');
    text(ctx,card.branch,903,939,49,'#153f30','bold',770);
    roundRect(ctx,120,1020,840,295,30,'#e8f3ea');
    text(ctx,'الخصم الخاص بك',900,1083,32,'#3c725b','bold');
    text(ctx,card.discount,900,1190,79,'#0b513a','bold',745);
    text(ctx,'صالحة حتى: '+formatExpiry(card.expiry),900,1273,30,'#4a6255');
    ctx.strokeStyle='#c8dbce';ctx.setLineDash([10,12]);ctx.lineWidth=3;
    ctx.beginPath();ctx.moveTo(135,1350);ctx.lineTo(942,1350);ctx.stroke();ctx.setLineDash([]);
    text(ctx,'رقم البطاقة',903,1420,30,'#62766a');
    text(ctx,card.code,903,1490,44,'#144734','bold');
    text(ctx,'تُعرض البطاقة في الفرع المحدد فقط',903,1570,26,'#65776b');
    ctx.fillStyle='#0a4839';ctx.fillRect(0,1680,1080,100);
    ctx.fillStyle='#f1e6c8';ctx.font='30px Tahoma, Arial, sans-serif';ctx.textAlign='center';ctx.direction='rtl';ctx.fillText('احتفظ بصورة الشاشة لإبرازها عند الزيارة',540,1743);
    return c.toDataURL('image/png');
  }

  function renderRoute() {
    const value = location.hash;
    if (!value.startsWith('#card=')) {
      document.body.classList.remove('card-mode');
      return;
    }
    document.body.classList.add('card-mode');
    try {
      const payload = JSON.parse(base64UrlToUtf8(value.slice(6)));
      const keys=['code','name','phone','branch','discount','expiry'];
      if (payload.v!==1 || keys.some(k => typeof payload[k]!=='string' || !payload[k] || payload[k].length>120) || !/^\d{4}-\d{2}-\d{2}$/.test(payload.expiry)) {
        throw new Error('بيانات البطاقة غير صالحة');
      }
      const img = $('customerCardImg');
      img.src = cardToImage(payload);
      img.style.display='block';
    } catch (e) {
      $('customerCardScreen').replaceChildren();
      const box = document.createElement('p'); box.className='invalid-card';
      box.textContent='رابط البطاقة غير صالح';
      $('customerCardScreen').appendChild(box);
    }
  }

  function init() {
    if (location.hash.startsWith('#card=')) {renderRoute();return;}
    $('expiry').min=todayPlus(0);
    $('expiry').value=todayPlus(14);
    $('clientId').value=settings.clientId;
    $('sheetId').value=settings.sheetId;
    if (!settings.clientId || !settings.sheetId) $('settingsPanel').open=true;
    if (location.protocol==='file:') message('أنت تفتح الصفحة من الجهاز مباشرة. ارفع الملفين على موقع HTTPS لتفعيل تسجيل Google وQR.', 'info');
    $('saveSettings').addEventListener('click',saveSettings);
    $('loginBtn').addEventListener('click',login);
    $('testBtn').addEventListener('click',testConnection);
    $('issueForm').addEventListener('submit',event => {lastStage='فحص البيانات والإعدادات'; return issue(event);});
    $('copyBtn').addEventListener('click',copyLink);
    window.addEventListener('hashchange',renderRoute);
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
  else init();
})();
