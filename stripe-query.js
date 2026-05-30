const Stripe = require('stripe');
require('dotenv').config();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function formatDate(timestamp) {
  if (!timestamp) return 'N/A';
  try {
    return new Date(timestamp * 1000).toISOString();
  } catch {
    return 'N/A';
  }
}

async function queryStripe() {
  console.log('='.repeat(80));
  console.log('LISTING ALL STRIPE CUSTOMERS');
  console.log('='.repeat(80));

  let customers = [];
  let hasMore = true;
  let startingAfter = undefined;

  while (hasMore) {
    const result = await stripe.customers.list({
      limit: 100,
      starting_after: startingAfter
    });
    customers = customers.concat(result.data);
    hasMore = result.has_more;
    if (hasMore && result.data.length > 0) {
      startingAfter = result.data[result.data.length - 1].id;
    }
    if (!hasMore) break;
  }

  console.log(`\nTotal customers: ${customers.length}\n`);

  for (const customer of customers) {
    console.log('-'.repeat(80));
    console.log('Customer ID:', customer.id);
    console.log('Email:', customer.email);
    console.log('Name:', customer.name);
    console.log('Created:', formatDate(customer.created));
    console.log('Metadata:', JSON.stringify(customer.metadata, null, 2));
  }

  console.log('\n' + '='.repeat(80));
  console.log('LISTING ALL STRIPE SUBSCRIPTIONS');
  console.log('='.repeat(80));

  let subscriptions = [];
  hasMore = true;
  startingAfter = undefined;

  while (hasMore) {
    const result = await stripe.subscriptions.list({
      limit: 100,
      starting_after: startingAfter,
      status: 'all'
    });
    subscriptions = subscriptions.concat(result.data);
    hasMore = result.has_more;
    if (hasMore && result.data.length > 0) {
      startingAfter = result.data[result.data.length - 1].id;
    }
    if (!hasMore) break;
  }

  console.log(`\nTotal subscriptions: ${subscriptions.length}\n`);

  for (const sub of subscriptions) {
    console.log('-'.repeat(80));
    console.log('ID:', sub.id);
    console.log('Status:', sub.status);
    console.log('Customer ID:', sub.customer);
    console.log('Created:', formatDate(sub.created));
    console.log('Current Period Start:', formatDate(sub.current_period_start));
    console.log('Current Period End:', formatDate(sub.current_period_end));
    console.log('Trial End:', formatDate(sub.trial_end));
    console.log('Cancel At Period End:', sub.cancel_at_period_end);
    console.log('Cancel At:', formatDate(sub.cancel_at));
    console.log('Canceled At:', formatDate(sub.canceled_at));
    console.log('Default Payment Method:', sub.default_payment_method);
    console.log('Metadata:', JSON.stringify(sub.metadata, null, 2));

    console.log('\n  Items:');
    for (const item of sub.items.data) {
      console.log('    - Price ID:', item.price?.id || 'N/A');
      console.log('      Product:', item.price?.product);
      console.log('      Unit Amount:', item.price?.unit_amount);
      console.log('      Currency:', item.price?.currency);
      console.log('      Recurring:', JSON.stringify(item.price?.recurring, null, 4));
    }

    // Get customer info
    try {
      const customer = await stripe.customers.retrieve(sub.customer);
      console.log('\n  Customer Info:');
      console.log('    Email:', customer.email);
      console.log('    Name:', customer.name);
      console.log('    Customer Metadata:', JSON.stringify(customer.metadata, null, 4));
    } catch (e) {
      console.log('\n  Customer Info: Could not retrieve (may be deleted)');
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('SEARCHING FOR NINETECH/SIXTEEN TECH CUSTOMERS');
  console.log('='.repeat(80));

  // Found customers with these emails
  const targetEmails = ['nineteenchmedia.team@gmail.com', 'shreywork18@gmail.com'];

  for (const email of targetEmails) {
    console.log(`\n${'='.repeat(40)}`);
    console.log(`DETAILED INFO FOR: ${email}`);
    console.log('='.repeat(40));

    const results = await stripe.customers.list({ email: email, limit: 10 });
    if (results.data.length > 0) {
      for (const customer of results.data) {
        console.log('\n--- CUSTOMER ---');
        console.log('ID:', customer.id);
        console.log('Email:', customer.email);
        console.log('Name:', customer.name);
        console.log('Created:', formatDate(customer.created));
        console.log('Default Source:', customer.default_source);
        console.log('Invoice Settings:', JSON.stringify(customer.invoice_settings, null, 2));
        console.log('Metadata:', JSON.stringify(customer.metadata, null, 2));

        // Find subscriptions for this customer
        const subs = await stripe.subscriptions.list({ customer: customer.id, limit: 10 });
        console.log(`\nSubscriptions for this customer: ${subs.data.length}`);
        for (const sub of subs.data) {
          console.log('\n  Subscription:');
          console.log('    ID:', sub.id);
          console.log('    Status:', sub.status);
          console.log('    Created:', formatDate(sub.created));
          console.log('    Current Period End:', formatDate(sub.current_period_end));
          console.log('    Trial End:', formatDate(sub.trial_end));
          console.log('    Cancel At Period End:', sub.cancel_at_period_end);
          console.log('    Default Payment Method:', sub.default_payment_method);
          console.log('    Metadata:', JSON.stringify(sub.metadata, null, 2));

          console.log('\n    Items:');
          for (const item of sub.items.data) {
            console.log('      - Price ID:', item.price?.id || 'N/A');
            console.log('        Product:', item.price?.product);
            console.log('        Unit Amount:', item.price?.unit_amount);
            console.log('        Currency:', item.price?.currency);
          }
        }
      }
    } else {
      console.log('No customers found');
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('DOMAIN METADATA SEARCH');
  console.log('='.repeat(80));

  const domainStrings = [
    'useninetechmediaa', 'useninetechmedia', 'goninetechmediaa', 'goninetechmedia',
    'nineetechmedia', 'seventechhmedia', 'seventechmedia', 'seventechmediaa',
    'tryninetechmediaa', 'tryninetechmedia'
  ];

  console.log('\nSearching for metadata containing:', domainStrings.join(', '));

  let matchCount = 0;
  for (const customer of customers) {
    const metaStr = JSON.stringify(customer.metadata).toLowerCase();
    for (const domainStr of domainStrings) {
      if (metaStr.includes(domainStr.toLowerCase())) {
        matchCount++;
        console.log(`\nMATCH #${matchCount} (customer metadata):`);
        console.log(' Customer ID:', customer.id);
        console.log('  Email:', customer.email);
        console.log('  Name:', customer.name);
        console.log('  Metadata:', JSON.stringify(customer.metadata));
        console.log('  Matched domain:', domainStr);
      }
    }
  }

  for (const sub of subscriptions) {
    const metaStr = JSON.stringify(sub.metadata).toLowerCase();
    for (const domainStr of domainStrings) {
      if (metaStr.includes(domainStr.toLowerCase())) {
        matchCount++;
        console.log(`\nMATCH #${matchCount} (subscription metadata):`);
        console.log('  Subscription ID:', sub.id);
        console.log('  Customer ID:', sub.customer);
        console.log('  Status:', sub.status);
        console.log('  Metadata:', JSON.stringify(sub.metadata));
        console.log('  Matched domain:', domainStr);
      }
    }
  }

  if (matchCount === 0) {
    console.log('\nNo matches found for any of the domain strings.');
  }

  console.log('\n' + '='.repeat(80));
  console.log('QUERY COMPLETE');
  console.log('='.repeat(80));
}

queryStripe().catch(console.error);