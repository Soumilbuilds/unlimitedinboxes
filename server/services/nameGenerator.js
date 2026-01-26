const firstNames = [
  'Emily', 'Emma', 'Olivia', 'Ava', 'Sophia', 'Isabella', 'Mia', 'Charlotte',
  'Amelia', 'Harper', 'Evelyn', 'Abigail', 'Ella', 'Avery', 'Scarlett', 'Grace',
  'Chloe', 'Victoria', 'Riley', 'Aria', 'Lily', 'Aubrey', 'Zoey', 'Penelope',
  'Layla', 'Nora', 'Camila', 'Hannah', 'Zoe', 'Lillian', 'Addison', 'Eleanor',
  'Natalie', 'Luna', 'Savannah', 'Brooklyn', 'Leah', 'Audrey', 'Stella', 'Bella',
  'Lucy', 'Paisley', 'Claire', 'Skylar', 'Violet', 'Ellie', 'Anna', 'Caroline',
  'Genesis', 'Aaliyah', 'Kennedy', 'Kinsley', 'Allison', 'Maya', 'Sarah', 'Madelyn',
  'Adeline', 'Alexa', 'Ariana', 'Elena', 'Gabriella', 'Naomi', 'Alice', 'Sadie',
  'Hailey', 'Eva', 'Emilia', 'Autumn', 'Quinn', 'Nevaeh', 'Piper', 'Ruby',
  'Serenity', 'Willow', 'Everly', 'Cora', 'Kaylee', 'Lydia', 'Aubree', 'Arianna',
  'Eliana', 'Peyton', 'Melanie', 'Gianna', 'Isabelle', 'Julia', 'Valentina', 'Nova',
  'Clara', 'Vivian', 'Reagan', 'Mackenzie', 'Madeline', 'Brielle', 'Delilah', 'Isla',
  'Rylee', 'Katherine', 'Sophie', 'Josephine', 'Ivy', 'Liliana', 'Jade', 'Maria',
  'Taylor', 'Hadley', 'Kylie', 'Emery', 'Adalynn', 'Natalia', 'Annabelle', 'Faith',
  'Alexandra', 'Ximena', 'Ashley', 'Brianna', 'Raelynn', 'Bailey', 'Mary', 'Athena'
];

const lastNames = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Rodriguez', 'Martinez', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin',
  'Lee', 'Thompson', 'White', 'Harris', 'Clark', 'Lewis', 'Robinson', 'Walker',
  'Hall', 'Allen', 'Young', 'King', 'Wright', 'Scott', 'Green', 'Baker',
  'Adams', 'Nelson', 'Carter', 'Mitchell', 'Roberts', 'Turner', 'Phillips', 'Campbell',
  'Parker', 'Evans', 'Edwards', 'Collins', 'Stewart', 'Morris', 'Murphy', 'Rivera',
  'Cook', 'Rogers', 'Morgan', 'Peterson', 'Cooper', 'Reed', 'Bailey', 'Bell',
  'Howard', 'Ward', 'Cox', 'Richardson', 'Wood', 'Watson', 'Brooks', 'Bennett',
  'Gray', 'James', 'Sanders', 'Price', 'Jenkins', 'Perry', 'Russell', 'Powell',
  'Long', 'Patterson', 'Hughes', 'Flores', 'Washington', 'Butler', 'Foster', 'Bryant'
];

const usedAliases = new Set();

export function generateMailboxName() {
  let attempts = 0;
  const maxAttempts = 1000;

  while (attempts < maxAttempts) {
    const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
    const fullName = `${firstName} ${lastName}`;
    const alias = `${firstName.toLowerCase()}${lastName.toLowerCase()}`;

    if (!usedAliases.has(alias)) {
      usedAliases.add(alias);
      return { fullName, alias };
    }
    attempts += 1;
  }

  const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
  const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
  const suffix = Math.floor(Math.random() * 9999);
  const alias = `${firstName.toLowerCase()}${lastName.toLowerCase()}${suffix}`;
  usedAliases.add(alias);

  return { fullName: `${firstName} ${lastName}`, alias };
}

export function resetUsedNames() {
  usedAliases.clear();
}

export function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
