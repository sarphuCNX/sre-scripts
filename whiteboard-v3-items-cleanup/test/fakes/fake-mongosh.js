'use strict';
/**
 * Fake `mongosh --nodb --quiet --norc --file cleanup.js` for end-to-end tests of run.sh.
 *
 * Like mongosh, it runs the --file script inside an async function (so top-level await works)
 * and provides the globals Mongo, EJSON, print and quit. The database lives in the JSON file
 * named by FAKE_MONGO_STATE and is saved on quit(), so the two phases (two processes) share it.
 * Each call's arguments and WB_CLEANUP_MONGO_URI are appended to FAKE_MONGO_CALLS.
 */

const fs = require('fs');
const { FAKE_EJSON, FakeDatabase, FakeMongo } = require('./fake-db.js');

const statePath = process.env.FAKE_MONGO_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(
  process.env.FAKE_MONGO_CALLS,
  `${JSON.stringify({ args, uri: process.env.WB_CLEANUP_MONGO_URI })}\n`
);

const database = new FakeDatabase(JSON.parse(fs.readFileSync(statePath, 'utf8')));
const saveAndExit = (code) => {
  fs.writeFileSync(statePath, JSON.stringify(database.state));
  process.exit(code);
};

globalThis.Mongo = function Mongo() {
  return new FakeMongo(database);
};
globalThis.EJSON = FAKE_EJSON;
globalThis.print = (text) => process.stdout.write(`${text}\n`);
globalThis.quit = saveAndExit;

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const script = fs.readFileSync(args[args.indexOf('--file') + 1], 'utf8');
new AsyncFunction('require', script)(require).catch((error) => {
  process.stderr.write(`MongoshUncaughtError: ${error.message}\n`);
  saveAndExit(1);
});
