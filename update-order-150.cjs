const Database = require('better-sqlite3');
const db = new Database('/opt/unlimited-inboxes/shared/db/app.db');

// Exactly 100 mailboxes from the system name generator
const mailboxes = [
  'evelyncollins@trykodekernel.us', 'evelynhoward@trykodekernel.us', 'averywhite@trykodekernel.us',
  'lilybrown@trykodekernel.us', 'claireprice@trykodekernel.us', 'charlotteanderson@trykodekernel.us',
  'annayoung@trykodekernel.us', 'raelynnanderson@trykodekernel.us', 'rubycox@trykodekernel.us',
  'isabellesmith@trykodekernel.us', 'carolinebrown@trykodekernel.us', 'elliereed@trykodekernel.us',
  'ariannagarcia@trykodekernel.us', 'isabellejenkins@trykodekernel.us', 'scarlettharris@trykodekernel.us',
  'briellethompson@trykodekernel.us', 'laylareed@trykodekernel.us', 'athenawood@trykodekernel.us',
  'natalieedwards@trykodekernel.us', 'ivymoore@trykodekernel.us', 'rileybaker@trykodekernel.us',
  'sophiemitchell@trykodekernel.us', 'alexislong@trykodekernel.us', 'alexandramorris@trykodekernel.us',
  'emilyprice@trykodekernel.us', 'serenitymitchell@trykodekernel.us', 'victoriaflores@trykodekernel.us',
  'kennedyfoster@trykodekernel.us', 'kinsleyjones@trykodekernel.us', 'quinnhall@trykodekernel.us',
  'gabriellamoore@trykodekernel.us', 'alexandrahughes@trykodekernel.us', 'sophiaevans@trykodekernel.us',
  'taylormartin@trykodekernel.us', 'kayleethompson@trykodekernel.us', 'chloerichardson@trykodekernel.us',
  'lunamorgan@trykodekernel.us', 'elianamorris@trykodekernel.us', 'evaclark@trykodekernel.us',
  'ellabrooks@trykodekernel.us', 'mayabutler@trykodekernel.us', 'ameliamiller@trykodekernel.us',
  'elliemartinez@trykodekernel.us', 'gracelee@trykodekernel.us', 'josephinewalker@trykodekernel.us',
  'gabriellarivera@trykodekernel.us', 'abigailmorgan@trykodekernel.us', 'baileyadams@trykodekernel.us',
  'graceevans@trykodekernel.us', 'taylorevans@trykodekernel.us', 'evelynpeterson@trykodekernel.us',
  'emmapowell@trykodekernel.us', 'evelewis@trykodekernel.us', 'lunarobinson@trykodekernel.us',
  'mayaturner@trykodekernel.us', 'carolinemartinez@trykodekernel.us', 'novamartin@trykodekernel.us',
  'carolineclark@trykodekernel.us', 'ellapeterson@trykodekernel.us', 'evapowell@trykodekernel.us',
  'savannahlee@trykodekernel.us', 'ellaward@trykodekernel.us', 'leahdavis@trykodekernel.us',
  'bellahughes@trykodekernel.us', 'adelinecampbell@trykodekernel.us', 'averyrodriguez@trykodekernel.us',
  'isabelleprice@trykodekernel.us', 'averybrooks@trykodekernel.us', 'kayleeharris@trykodekernel.us',
  'naomicox@trykodekernel.us', 'mackenzieturner@trykodekernel.us', 'emiliacooper@trykodekernel.us',
  'melaniecox@trykodekernel.us', 'aubreeperry@trykodekernel.us', 'elliemurphy@trykodekernel.us',
  'stellayoung@trykodekernel.us', 'ariannarodriguez@trykodekernel.us', 'ariannacampbell@trykodekernel.us',
  'averyrichardson@trykodekernel.us', 'nataliacox@trykodekernel.us', 'aaliyahmoore@trykodekernel.us',
  'ellamitchell@trykodekernel.us', 'briannawhite@trykodekernel.us', 'arianelson@trykodekernel.us',
  'aaliyahrogers@trykodekernel.us', 'emeryadams@trykodekernel.us', 'carolineward@trykodekernel.us',
  'arianabennett@trykodekernel.us', 'leahlong@trykodekernel.us', 'sarahwilliams@trykodekernel.us',
  'haileycooper@trykodekernel.us', 'miabaker@trykodekernel.us', 'elliejohnson@trykodekernel.us',
  'rubyjames@trykodekernel.us', 'mayarobinson@trykodekernel.us'
];

console.log('Mailboxes to record:', mailboxes.length);

const update = db.prepare(`
  UPDATE orders
  SET created_mailboxes = ?,
      total_mailboxes = ?,
      progress = 100,
      status = 'completed'
  WHERE id = 150
`).run(JSON.stringify(mailboxes), mailboxes.length);

console.log('Updated:', update.changes);

const order = db.prepare('SELECT * FROM orders WHERE id = 150').get();
const created = JSON.parse(order.created_mailboxes);
console.log('Final count:', created.length);
console.log('Total mailboxes in order:', order.total_mailboxes);
console.log('Status:', order.status);
console.log('');
console.log('SUCCESS! 100 mailboxes created for trykodekernel.us');