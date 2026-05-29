const http = require('http');

const key = process.argv[2] || 'f701192ed7d253b9b094933e85d7245f072136099a7c56b3c257203981398028';

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/orders',
  method: 'GET',
  headers: {
    'x-api-key': key
  }
};

const req = http.request(options, (res) => {
  console.log('Status:', res.statusCode);
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log('Response:', data);
  });
});

req.on('error', (e) => {
  console.error('Error:', e.message);
});

req.end();