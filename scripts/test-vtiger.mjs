import https from 'https';
import crypto from 'crypto';

const baseUrl = process.env.VTIGER_URL ?? 'https://containerzone.od2.vtiger.com';
const username = process.env.VTIGER_USERNAME ?? 'info@containerzone.com.au';
const accessKey = process.env.VTIGER_ACCESS_KEY ?? 'z5KDOyeq5erck5zl';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Request timed out')));
  });
}

async function main() {
  console.log('Testing Vtiger API at:', baseUrl);
  
  // Step 1: challenge
  const challenge = await get(`${baseUrl}/webservice.php?operation=getchallenge&username=${encodeURIComponent(username)}`);
  if (!challenge.success) throw new Error('Challenge failed: ' + JSON.stringify(challenge));
  console.log('Challenge OK, token:', challenge.result.token);
  
  const token = challenge.result.token;
  const key = crypto.createHash('md5').update(token + accessKey).digest('hex');
  
  // Step 2: login
  const login = await get(`${baseUrl}/webservice.php?operation=login&username=${encodeURIComponent(username)}&accessKey=${key}`);
  if (!login.success) throw new Error('Login failed: ' + JSON.stringify(login));
  console.log('LOGIN OK. sessionName:', login.result.sessionName, 'userId:', login.result.userId);
  
  const session = login.result.sessionName;
  
  // Step 3: describe Quotes module to get field names
  const desc = await get(`${baseUrl}/webservice.php?operation=describe&sessionName=${session}&elementType=Quotes`);
  if (!desc.success) throw new Error('Describe failed: ' + JSON.stringify(desc));
  
  const fields = desc.result.fields;
  console.log('\n=== QUOTES MODULE FIELDS ===');
  for (const f of fields) {
    console.log(`  ${f.name} (${f.type?.name ?? f.type}) — label: "${f.label}"`);
  }
  
  // Step 4: describe Potentials (Deals) module
  const descDeals = await get(`${baseUrl}/webservice.php?operation=describe&sessionName=${session}&elementType=Potentials`);
  if (!descDeals.success) throw new Error('Describe Potentials failed: ' + JSON.stringify(descDeals));
  
  const dealFields = descDeals.result.fields;
  console.log('\n=== POTENTIALS (DEALS) MODULE FIELDS ===');
  for (const f of dealFields) {
    console.log(`  ${f.name} (${f.type?.name ?? f.type}) — label: "${f.label}"`);
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
