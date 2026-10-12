'use strict';
/**
 * Every database call the cleanup makes, in one place.
 *
 * Modules loaded with require() are not rewritten by mongosh's async rewriter, so each
 * collection call returns a Promise there and is awaited here.
 */

const { Aborted } = require('./errors.js');

const LEGACY_COLLECTION = 'flowitems';
const V3_COLLECTION = 'flowitementryv3';
const BACKUP_INDEX_NAME = 'flowId_unique';
const DUPLICATE_PROBE_LIMIT = 2;
const DUPLICATE_KEY_CODE = 11000;
const NAMESPACE_NOT_FOUND_CODE = 26;
const MAJORITY = { writeConcern: { w: 'majority' } };

/**
 * Tell whether an index key is exactly {flowId: 1}.
 *
 * @param {object} key - the index key document.
 * @returns {boolean} true for a single ascending flowId key.
 */
function isFlowIdKey(key) {
  const fields = Object.keys(key || {});
  return fields.length === 1 && fields[0] === 'flowId' && Number(key.flowId) === 1;
}

/** Reads and writes flowitems, flowitementryv3 and the backup collection. */
class FlowStore {
  /**
   * @param {object} database - the whiteboard database (mongosh Database).
   * @param {string} backupCollectionName - the validated backup collection name.
   */
  constructor(database, backupCollectionName) {
    this.legacy = database.getCollection(LEGACY_COLLECTION);
    this.v3 = database.getCollection(V3_COLLECTION);
    this.backup = database.getCollection(backupCollectionName);
    this.backupCollectionName = backupCollectionName;
  }

  /**
   * @param {string} flowId - the flow.
   * @returns {Promise<object[]>} its flowitems documents; two are enough to spot duplicates.
   */
  async findFlowDocuments(flowId) {
    const cursor = await this.legacy.find({ flowId });
    return cursor.limit(DUPLICATE_PROBE_LIMIT).toArray();
  }

  /**
   * @param {string} flowId - the flow.
   * @param {{limit?: number}} [options] - pass {limit: 1} when only "any?" matters.
   * @returns {Promise<number>} the flow's flowitementryv3 entries.
   */
  async countV3Entries(flowId, options = {}) {
    return this.v3.countDocuments({ flowId }, options);
  }

  /**
   * @param {string} flowId - the flow.
   * @returns {Promise<object|null>} its backup document, if one exists.
   */
  async findBackup(flowId) {
    return this.backup.findOne({ flowId });
  }

  /**
   * Make sure the backup collection has a unique {flowId: 1} index, creating it if missing.
   *
   * @returns {Promise<void>}
   * @throws {Aborted} if a non-unique flowId index exists or the index cannot be built.
   */
  async ensureBackupIndex() {
    const existing = (await this.listBackupIndexes()).find((index) => isFlowIdKey(index.key));
    if (existing && existing.unique) {
      return;
    }
    if (existing) {
      throw new Aborted(
        `${this.backupCollectionName} has a non-unique flowId index '${existing.name}'; ` +
          'drop it or choose another WB_CLEANUP_BACKUP_COLLECTION'
      );
    }
    try {
      await this.backup.createIndex({ flowId: 1 }, { unique: true, name: BACKUP_INDEX_NAME });
    } catch (error) {
      throw new Aborted(
        `cannot create a unique flowId index on ${this.backupCollectionName}: ${error.message}`
      );
    }
  }

  /** @returns {Promise<object[]>} the backup collection's indexes; none if it does not exist. */
  async listBackupIndexes() {
    try {
      return await this.backup.getIndexes();
    } catch (error) {
      if (error && error.code === NAMESPACE_NOT_FOUND_CODE) {
        return [];
      }
      throw error;
    }
  }

  /**
   * @param {string} flowId - the flow.
   * @param {object[]} items - flow.items, unchanged.
   * @returns {Promise<*>} the new backup's _id.
   * @throws {Aborted} if a backup for the flowId was inserted meanwhile.
   */
  async insertBackup(flowId, items) {
    try {
      return (await this.backup.insertOne({ flowId, items }, MAJORITY)).insertedId;
    } catch (error) {
      if (error && error.code === DUPLICATE_KEY_CODE) {
        throw new Aborted(`${this.backupCollectionName} already holds flowId ${flowId}`);
      }
      throw error;
    }
  }

  /**
   * @param {*} backupId - the backup's _id.
   * @returns {Promise<number>} its item count, counted on the server; -1 if missing.
   */
  async countBackupItems(backupId) {
    const cursor = await this.backup.aggregate([
      { $match: { _id: backupId } },
      { $project: { count: { $cond: [{ $isArray: '$items' }, { $size: '$items' }, -1] } } },
    ]);
    const [result] = await cursor.toArray();
    return result === undefined ? -1 : result.count;
  }

  /**
   * @param {*} backupId - the backup's _id.
   * @returns {Promise<void>}
   */
  async deleteBackup(backupId) {
    await this.backup.deleteOne({ _id: backupId }, MAJORITY);
  }

  /**
   * Set flow.items to [] only if _id, updatedAt and the item count still match `document`.
   *
   * @param {object} document - the flowitems document as verified.
   * @returns {Promise<boolean>} true if cleared; false if the document changed.
   */
  async clearItems(document) {
    const result = await this.legacy.updateOne(
      {
        _id: document._id,
        updatedAt: document.updatedAt === undefined ? null : document.updatedAt,
        'flow.items': { $size: document.flow.items.length },
      },
      { $set: { 'flow.items': [] } },
      MAJORITY
    );
    return result.modifiedCount === 1;
  }
}

module.exports = { FlowStore };
