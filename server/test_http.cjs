const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/orders',
  method: 'GET',
  headers: {
    'x-api-key': 'e08dd1d6bba07ff387951ceb7c80f9538fa8b379702b77dee70cef04983f3bd4'
  }
};

const req = http.request(options, (res) => {
  console.log('Status:', res.statusCode);
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log('Response:', data);
    process.exit(0);
  });
});

req.on('error', (e) => {
  console.error('Error:', e.message);
  process.exit(1);
});

req.end();