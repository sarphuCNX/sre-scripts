'use strict';
/** Pure checks: is the flow eligible, and is a document or backup unchanged. No database access. */

const { Aborted } = require('./errors.js');

const V3_VERSION = 3;
const CANONICAL = { relaxed: false };

/**
 * Check that the flow is v3, migrated, has v3 entries and a non-empty flow.items.
 * A missing `version` means v1, as in EinsClass-Server.
 *
 * @param {string} flowId - the flow, used in messages.
 * @param {object[]} documents - the flowitems documents with this flowId (at most two).
 * @param {number} v3EntryCount - flowitementryv3 entries with this flowId (may be capped at 1).
 * @returns {{documentId: *, itemCount: number, v3EntryCount: number}} the checked facts.
 * @throws {Aborted} naming the first check that failed.
 */
function checkEligibility(flowId, documents, v3EntryCount) {
  if (documents.length === 0) {
    throw new Aborted(`no flowitems document has flowId ${flowId}`);
  }
  if (documents.length > 1) {
    throw new Aborted(`more than one flowitems document has flowId ${flowId}; expected exactly 1`);
  }
  const [document] = documents;
  if (document.version !== V3_VERSION) {
    throw new Aborted(`flow ${flowId} has version ${JSON.stringify(document.version)}, expected 3`);
  }
  const flow = document.flow;
  if (flow === null || typeof flow !== 'object' || Array.isArray(flow)) {
    throw new Aborted(`flow ${flowId} has no 'flow' object`);
  }
  if (!flow.migratedAt) {
    throw new Aborted(`flow ${flowId} has no flow.migratedAt; it was not migrated`);
  }
  if (v3EntryCount <= 0) {
    throw new Aborted(`flow ${flowId} has no flowitementryv3 entries`);
  }
  if (!Array.isArray(flow.items)) {
    throw new Aborted(`flow ${flowId} has no flow.items array`);
  }
  if (flow.items.length === 0) {
    throw new Aborted(`flow ${flowId} already has an empty flow.items; nothing to do`);
  }
  return { documentId: document._id, itemCount: flow.items.length, v3EntryCount };
}

/**
 * Compare two BSON values exactly, types included, via canonical Extended JSON.
 *
 * @param {object} EJSON - the bson EJSON implementation.
 * @param {*} left - a value; undefined counts as null.
 * @param {*} right - a value; undefined counts as null.
 * @returns {boolean} true if identical.
 */
function sameValue(EJSON, left, right) {
  const encode = (value) =>
    EJSON.stringify({ value: value === undefined ? null : value }, undefined, undefined, CANONICAL);
  return encode(left) === encode(right);
}

/**
 * Tell whether a flowitems document is unchanged: same _id, updatedAt and flow.items.
 *
 * @param {object} EJSON - the bson EJSON implementation.
 * @param {object} current - the document as read now.
 * @param {object} reference - the document as exported.
 * @returns {boolean} true if nothing that matters changed.
 */
function sameFlowState(EJSON, current, reference) {
  return (
    sameValue(EJSON, current._id, reference._id) &&
    sameValue(EJSON, current.updatedAt, reference.updatedAt) &&
    sameValue(EJSON, current.flow.items, reference.flow.items)
  );
}

module.exports = { checkEligibility, sameFlowState, sameValue };
