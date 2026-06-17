const crypto = require('crypto');
const readline = require('readline');
const { scrypt } = require('crypto');

const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 32;
const SESSION_SECRET_BYTES = 32;
const SCRYPT_OPTIONS = { cost: 16384, blockSize: 8, parallelization: 1 };

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

function askHidden(prompt) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(prompt);

    const onData = char => {
      char = char.toString();
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          stdin.off('data', onData);
          stdin.setRawMode?.(false);
          stdout.write('\n');
          resolve(buffer);
          break;
        case '\u0003':
          process.exit(130);
          break;
        case '\u007f':
          buffer = buffer.slice(0, -1);
          break;
        default:
          buffer += char;
          break;
      }
    };

    let buffer = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function derivePasswordHash(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, PASSWORD_HASH_BYTES, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function main() {
  const username = String(await ask('Username: ')).trim();
  const password = String(await askHidden('Password: '));
  const confirmation = String(await askHidden('Confirm password: '));
  if (!username) throw new Error('Username is required.');
  if (!password) throw new Error('Password is required.');
  if (password !== confirmation) throw new Error('Passwords do not match.');

  const salt = crypto.randomBytes(PASSWORD_SALT_BYTES);
  const hash = await derivePasswordHash(password, salt);
  const sessionSecret = crypto.randomBytes(SESSION_SECRET_BYTES);

  console.log('');
  console.log('DIPLOMACY_AUTH_ENABLED=true');
  console.log(`DIPLOMACY_AUTH_USERNAME=${username}`);
  console.log(`DIPLOMACY_AUTH_PASSWORD_SALT=${salt.toString('hex')}`);
  console.log(`DIPLOMACY_AUTH_PASSWORD_HASH=${hash.toString('hex')}`);
  console.log(`DIPLOMACY_AUTH_SESSION_SECRET=${sessionSecret.toString('hex')}`);
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
