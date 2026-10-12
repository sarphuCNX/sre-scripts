'use strict';
/**
 * mongosh entry point. Run it only through run.sh, which sets the WB_CLEANUP_* variables:
 *   mongosh --nodb --quiet --norc --file cleanup.js
 *
 * The connection string is read from WB_CLEANUP_MONGO_URI here instead of being a mongosh
 * argument, so credentials never appear in the process list. All logic lives in lib/.
 */

/* global Mongo, EJSON, print, quit */
const EXIT_ERROR = 20;

if (!process.env.WB_CLEANUP_MONGO_URI || !process.env.WB_CLEANUP_LIB) {
  print('error: WB_CLEANUP_MONGO_URI and WB_CLEANUP_LIB must be set; run this through run.sh');
  quit(EXIT_ERROR);
}

const { main } = require(process.env.WB_CLEANUP_LIB);
const connection = new Mongo(process.env.WB_CLEANUP_MONGO_URI);

quit(await main({ connection, env: process.env, fs: require('fs'), EJSON, print }));
