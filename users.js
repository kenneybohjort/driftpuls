// Hantera användare:  docker exec -it drift-admin node users.js list|add|passwd|role|totp-off|remove NAMN [admin|tekniker]
const readline = require('readline');
const { users } = require('./auth')(process.env.DATA_DIR || __dirname);
const [cmd, name, roleArg] = process.argv.slice(2);

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => rl.output.write(muted ? '' : s);
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
    muted = true;
  });
}

(async () => {
  try {
    if (cmd === 'list') {
      const list = users.listDetailed();
      console.log(list.map((u) => `${u.username}\t[${u.role}]${u.totpEnabled ? '\t(2FA)' : ''}`).join('\n') || '(inga användare)');
    } else if (cmd === 'add' && name) {
      const role = roleArg || 'admin';
      const a = await ask('Lösenord (minst 12 tecken): ');
      const b = await ask('Upprepa lösenordet: ');
      if (a !== b) throw new Error('Lösenorden är olika');
      users.add(name, a, role);
      console.log(`Klart (${name}, roll: ${role}).`);
    } else if (cmd === 'passwd' && name) {
      const a = await ask('Lösenord (minst 12 tecken): ');
      const b = await ask('Upprepa lösenordet: ');
      if (a !== b) throw new Error('Lösenorden är olika');
      users.passwd(name, a);
      console.log('Klart.');
    } else if (cmd === 'role' && name && roleArg) {
      users.setRole(name, roleArg);
      console.log(`Klart (${name} -> ${roleArg}).`);
    } else if (cmd === 'totp-off' && name) {
      users.disableTotp(name);
      console.log(`2FA inaktiverad för ${name}.`);
    } else if (cmd === 'remove' && name) {
      users.remove(name);
      console.log('Klart.');
    } else {
      console.log('Användning: node users.js list | add NAMN [admin|tekniker] | passwd NAMN | role NAMN admin|tekniker | totp-off NAMN | remove NAMN');
    }
  } catch (e) { console.error('Fel:', e.message); process.exit(1); }
})();
