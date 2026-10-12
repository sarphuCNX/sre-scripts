'use strict';
/**
 * In-memory stand-in for the slice of mongosh's Database/Collection API the server lib uses.
 *
 * Like mongosh for require()d code, every collection call returns a Promise, so a missing
 * `await` in the lib fails here too. Values are plain JSON (ids and dates are strings), so a
 * JSON-based fake EJSON is enough. `state.faults` simulates a short backup or a concurrent edit.
 */

const NAMESPACE_NOT_FOUND_CODE = 26;
const DUPLICATE_KEY_CODE = 11000;

function getPath(document, path) {
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), document);
}

function setPath(document, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((node, key) => node[key], document)[last] = value;
}

/** Equality (null matches missing) and $size, the only filters the lib sends. */
function matches(document, filter) {
  return Object.entries(filter).every(([path, condition]) => {
    const value = getPath(document, path);
    if (condition !== null && typeof condition === 'object' && '$size' in condition) {
      return Array.isArray(value) && value.length === condition.$size;
    }
    if (condition === null) {
      return value === null || value === undefined;
    }
    return JSON.stringify(value) === JSON.stringify(condition);
  });
}

function serverError(message, code) {
  return Object.assign(new Error(message), { code });
}

class FakeCursor {
  constructor(documents) {
    this.documents = documents;
  }

  limit(count) {
    return new FakeCursor(this.documents.slice(0, count));
  }

  async toArray() {
    return structuredClone(this.documents);
  }
}

class FakeCollection {
  constructor(database, name) {
    this.database = database;
    this.name = name;
  }

  /** Stored documents; reading never creates the collection, like MongoDB. */
  get documents() {
    return this.database.state.collections[this.name] || [];
  }

  get exists() {
    return this.name in this.database.state.collections;
  }

  create() {
    this.database.state.collections[this.name] = this.documents;
    this.database.state.indexes[this.name] = this.database.state.indexes[this.name] || [];
  }

  async find(filter) {
    return new FakeCursor(this.documents.filter((document) => matches(document, filter)));
  }

  async findOne(filter) {
    const found = this.documents.find((document) => matches(document, filter));
    return found === undefined ? null : structuredClone(found);
  }

  async countDocuments(filter, options = {}) {
    const count = this.documents.filter((document) => matches(document, filter)).length;
    return options.limit ? Math.min(count, options.limit) : count;
  }

  async getIndexes() {
    if (!this.exists) {
      throw serverError(`ns does not exist: ${this.name}`, NAMESPACE_NOT_FOUND_CODE);
    }
    return structuredClone(this.database.state.indexes[this.name]);
  }

  async createIndex(key, options = {}) {
    const field = Object.keys(key)[0];
    const values = this.documents.map((document) => JSON.stringify(document[field]));
    if (options.unique && new Set(values).size !== values.length) {
      throw serverError('E11000 duplicate key error collection', DUPLICATE_KEY_CODE);
    }
    this.create();
    this.database.state.indexes[this.name].push({ key, name: options.name, unique: !!options.unique });
    return options.name;
  }

  async insertOne(document) {
    this.create();
    const uniqueFields = this.database.state.indexes[this.name]
      .filter((index) => index.unique)
      .map((index) => Object.keys(index.key)[0]);
    const duplicate = uniqueFields.some((field) =>
      this.documents.some((existing) => JSON.stringify(existing[field]) === JSON.stringify(document[field]))
    );
    if (duplicate) {
      throw serverError('E11000 duplicate key error', DUPLICATE_KEY_CODE);
    }
    const insertedId = `backup-${this.documents.length + 1}`;
    const stored = structuredClone({ _id: insertedId, ...document });
    const faults = this.database.state.faults || {};
    if (faults.shortBackup) {
      stored.items.pop();
    }
    this.documents.push(stored);
    if (faults.editItemDuringBackup) {
      this.database.editLegacyItemInPlace();
    }
    if (faults.failAfterBackup) {
      throw new Error('connection reset after backup');
    }
    return { acknowledged: true, insertedId };
  }

  async aggregate(pipeline) {
    let documents = this.documents;
    for (const stage of pipeline) {
      if (stage.$match) {
        documents = documents.filter((document) => matches(document, stage.$match));
      } else if (stage.$project && stage.$project.count) {
        documents = documents.map((document) => ({
          _id: document._id,
          count: Array.isArray(document.items) ? document.items.length : -1,
        }));
      }
    }
    return new FakeCursor(documents);
  }

  async deleteOne(filter) {
    const index = this.documents.findIndex((document) => matches(document, filter));
    if (index >= 0) {
      this.documents.splice(index, 1);
    }
    return { acknowledged: true, deletedCount: index >= 0 ? 1 : 0 };
  }

  async updateOne(filter, update) {
    const document = this.documents.find((candidate) => matches(candidate, filter));
    if (!document) {
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    }
    Object.entries(update.$set).forEach(([path, value]) => setPath(document, path, value));
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  }
}

/** A database whose whole content is the JSON-serializable `state`. */
class FakeDatabase {
  constructor(state) {
    this.state = state;
    this.state.collections = this.state.collections || {};
    this.state.indexes = this.state.indexes || {};
  }

  getCollection(name) {
    return new FakeCollection(this, name);
  }

  editLegacyItemInPlace() {
    for (const document of this.getCollection('flowitems').documents) {
      document.flow.items[0] = { id: 'edited' };
      document.updatedAt = '2026-10-12T04:00:05.000Z';
    }
  }
}

/** Stand-in for mongosh's Mongo connection. */
class FakeMongo {
  constructor(database) {
    this.database = database;
    this.requestedDatabases = [];
  }

  getDB(name) {
    this.requestedDatabases.push(name);
    return this.database;
  }
}

/** EJSON stand-in: the fake world holds only JSON values. */
const FAKE_EJSON = {
  stringify: (value) => JSON.stringify(value),
  parse: (text) => JSON.parse(text),
};

module.exports = { FAKE_EJSON, FakeDatabase, FakeMongo };
