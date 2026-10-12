'use strict';
/** The pre-change export file: canonical Extended JSON, written atomically, verified on read. */

const { Aborted } = require('./errors.js');

const CANONICAL = { relaxed: false };

/**
 * Count flow.items in a document.
 *
 * @param {object} document - a flowitems document.
 * @returns {number} the count, or -1 when there is no items array.
 */
function itemCount(document) {
  const items = document && document.flow && document.flow.items;
  return Array.isArray(items) ? items.length : -1;
}

/**
 * Read an export file back.
 *
 * @param {{fs: object, EJSON: object}} deps - filesystem and EJSON.
 * @param {string} exportFile - the export path.
 * @returns {object} the exported document, with exact BSON types.
 * @throws {Aborted} if the file is missing or not valid Extended JSON.
 */
function readExport({ fs, EJSON }, exportFile) {
  try {
    return EJSON.parse(fs.readFileSync(exportFile, 'utf8'), CANONICAL);
  } catch (error) {
    throw new Aborted(`cannot read export ${exportFile}: ${error.message}`);
  }
}

/**
 * Write the document atomically (temporary file, then rename), read it back and compare
 * the flow.items count.
 *
 * @param {{fs: object, EJSON: object}} deps - filesystem and EJSON.
 * @param {object} document - the full flowitems document.
 * @param {string} exportFile - destination; must not exist yet.
 * @returns {string} the export path.
 * @throws {Aborted} if the file exists or reads back with a different count.
 */
function writeExport({ fs, EJSON }, document, exportFile) {
  if (fs.existsSync(exportFile)) {
    throw new Aborted(`export file already exists: ${exportFile}`);
  }
  const temporaryFile = `${exportFile}.tmp`;
  fs.writeFileSync(temporaryFile, `${EJSON.stringify(document, undefined, undefined, CANONICAL)}\n`);
  fs.renameSync(temporaryFile, exportFile);
  if (itemCount(readExport({ fs, EJSON }, exportFile)) !== itemCount(document)) {
    throw new Aborted(`export ${exportFile} read back with a different flow.items count`);
  }
  return exportFile;
}

module.exports = { readExport, writeExport };
