import { assert } from '@ember/debug';
import { getOwner } from '@ember/application';
import { get } from '@ember/object';
import { on } from '@ember/object/evented';
import { isEmpty } from '@ember/utils';
import { bind } from '@ember/runloop';
import { classify, camelize } from '@ember/string';


import DS from 'ember-data';
import { pluralize } from 'ember-inflector';
import RSVP from 'rsvp';
import { v4 } from 'uuid';
//import BelongsToRelationship from 'ember-data/-private/system/relationships/state/belongs-to';

import {
  extractDeleteRecord,
  shouldSaveRelationship,
  configFlagDisabled
} from '../utils';

//BelongsToRelationship.reopen({
//  findRecord() {
//    return this._super().catch(() => {
//      //not found: deleted
//      this.clear();
//    });
//  }
//});

export default DS.RESTAdapter.extend({

  fixDeleteBug: true,
  coalesceFindRequests: false,

  init() {
    this._super(arguments);
    this._indexPromises = [];
    this._pouchConfig = getOwner(this).resolveRegistration('config:environment')['ember-pouch'];
    this.createdRecords = {};
    this.waitingForConsistency = {};
  },

  // The change listener ensures that individual records are kept up to date
  // when the data in the database changes. This makes ember-data 2.0's record
  // reloading redundant.
  shouldReloadRecord: function () { return false; },
  shouldBackgroundReloadRecord: function () { return false; },
  _onInit: on('init', function()  {
    this._startChangesToStoreListener();
  }),
  _startChangesToStoreListener: function() {
    const db = this.get('db');
    if (db && !this.changes) { // only run this once
      const onChangeListener = bind(this, 'onChange');
      this.set('onChangeListener', onChangeListener);
      this.changes = db.changes({
        since: 'now',
        live: true,
        returnDocs: false
      });
      this.changes.on('change', onChangeListener);
    }
  },

  _stopChangesListener: function() {
    if (this.changes) {
      const onChangeListener = this.get('onChangeListener');
      this.changes.removeListener('change', onChangeListener);
      this.changes.cancel();
      this.changes = undefined;
    }
  },
  changeDb: function(db) {
    console.log('changeDb', db); // eslint-disable-line no-console
    this._stopChangesListener();

    const store = this.store;
    const schema = this._schema || [];

    for (let i = 0, len = schema.length; i < len; i++) {
      store.unloadAll(schema[i].singular);
    }

    this._schema = null;
    this.set('db', db);
    this._startChangesToStoreListener();
  },
  onChange: function (change) {
    console.log('onChange', change); // eslint-disable-line no-console
    return; // FIXME: disabling for now

    // If relational_pouch isn't initialized yet, there can't be any records
    // in the store to update.
    if (!this.get('db').rel) { return; }

    const obj = this.get('db').rel.parseDocID(change.id);
    // skip changes for non-relational_pouch docs. E.g., design docs.
    if (!obj.type || !obj.id || obj.type === '') { return; }

    if (this.waitingForConsistency[change.id]) {
      const promise = this.waitingForConsistency[change.id];
      delete this.waitingForConsistency[change.id];
      if (change.deleted) {
        promise.reject("deleted");
      } else {
        promise.resolve(this._findRecord(obj.type, obj.id));
      }
      return;
    }

    const store = this.store;
    if (store.isDestroyed) {
      // The store has been destroyed (e.g. in test environment)
      // If execution reaches this point it is probably a bug.
      return;
    }
    try {
      store.modelFor(obj.type);
    } catch (e) {
      // The record refers to a model which this version of the application
      // does not have.
      return;
    }

    const recordInStore = store.peekRecord(obj.type, obj.id);
    if (!recordInStore) {
      // The record hasn't been loaded into the store; no need to reload its data.
      if (this.createdRecords[obj.id]) {
        delete this.createdRecords[obj.id];
      } else {
        this.unloadedDocumentChanged(obj);
      }
      return;
    }
    if (!recordInStore.get('isLoaded') || recordInStore.get('rev') === change.changes[0].rev || recordInStore.get('hasDirtyAttributes')) {
      // The record either hasn't loaded yet or has unpersisted local changes.
      // In either case, we don't want to refresh it in the store
      // (and for some substates, attempting to do so will result in an error).
      // We also ignore the change if we already have the latest revision
      return;
    }

    //debugger;
    if (change.deleted) {
      //if (!recordInStore._internalModel.isDeleted()) {
      if (this.fixDeleteBug) {
        recordInStore._internalModel.transitionTo('deleted.saved');//work around ember-data bug
      } else {
        store.unloadRecord(recordInStore);
      }
      //}
    } else {
      recordInStore.reload();
    }
  },

  unloadedDocumentChanged: function(/* obj */) {
    /*
     * For performance purposes, we don't load records into the store that haven't previously been loaded.
     * If you want to change this, subclass this method, and push the data into the store. e.g.
     *
     *  let store = this.get('store');
     *  let recordTypeName = this.getRecordTypeName(store.modelFor(obj.type));
     *  this.get('db').rel.find(recordTypeName, obj.id).then(function(doc){
     *    store.pushPayload(recordTypeName, doc);
     *  });
     */
  },

  willDestroy: function() {
    console.log('willDestroy'); // eslint-disable-line no-console
    this._stopChangesListener();
  },

  _indexPromises: null,

  _init: function (store, type) {
    const self = this,
        recordTypeName = this.getRecordTypeName(type);
    if (!this.get('db') || typeof this.get('db') !== 'object') {
      throw new Error('Please set the `db` property on the adapter.');
    }

    if (!get(type, 'attributes').has('rev')) {
      const modelName = classify(recordTypeName);
      throw new Error('Please add a `rev` attribute of type `string`' +
        ' on the ' + modelName + ' model.');
    }

    this._schema = this._schema || [];

    const singular = recordTypeName;
    const plural = pluralize(recordTypeName);

    // check that we haven't already registered this model
    for (let i = 0, len = this._schema.length; i < len; i++) {
      const currentSchemaDef = this._schema[i];
      if (currentSchemaDef.singular === singular) {
        return;
      }
    }

    const schemaDef = {
      singular: singular,
      plural: plural
    };

    if (type.documentType) {
      schemaDef['documentType'] = type.documentType;
    }

    // TODO: generalize & document config/env
    let config = getOwner(this).resolveRegistration('config:environment');
    // else it's new, so update
    this._schema.push(schemaDef);
    // check all the subtypes
    // We check the type of `rel.type`because with ember-data beta 19
    // `rel.type` switched from DS.Model to string
    type.eachRelationship(function (_, rel) {
      if (rel.kind !== 'belongsTo' && rel.kind !== 'hasMany') {
        // TODO: support inverse as well
        return; // skip
      }
      const relDef = {},
          relModel = (typeof rel.type === 'string' ? store.modelFor(rel.type) : rel.type);
      if (relModel) {
        let includeRel = true;
        if (!('options' in rel)) {
          rel.options = {};
        }
        if (typeof(rel.options.async) === "undefined") {
          rel.options.async = config.emberPouch && !isEmpty(config.emberPouch.async) ? config.emberPouch.async : true;//default true from https://github.com/emberjs/data/pull/3366
        }
        let options = Object.create(rel.options);
        if (rel.kind === 'hasMany' && !shouldSaveRelationship(self, rel)) {
          let inverse = type.inverseFor(rel.key, store);
          if (inverse) {
            if (inverse.kind === 'belongsTo') {
              self._indexPromises.push(self.get('db').createIndex({index: { fields: ['data.' + inverse.name, '_id'] }}));
              if (options.async) {
                includeRel = false;
              } else {
                options.queryInverse = inverse.name;
              }
            }
          }
        }

        if (includeRel) {
          relDef[rel.kind] = {
            type: self.getRecordTypeName(relModel),
            options: options
          };
          if (!schemaDef.relations) {
            schemaDef.relations = {};
          }
          schemaDef.relations[rel.key] = relDef;
        }
        self._init(store, relModel);
      }
    });

    this.get('db').setSchema(this._schema);
  },

  _recordToData: function (store, type, record) {
    let data = {};
    // Though it would work to use the default recordTypeName for modelName &
    // serializerKey here, these uses are conceptually distinct and may vary
    // independently.
    const modelName = type.modelName || type.typeKey;
    const serializerKey = camelize(modelName);
    const serializer = store.serializerFor(modelName);

    serializer.serializeIntoHash(
      data,
      type,
      record,
      {includeId: true}
    );

    data = data[serializerKey];

    // ember sets it to null automatically. don't need it.
    if (data.rev === null) {
      delete data.rev;
    }

    return data;
  },

  /**
   * Return key that conform to data adapter
   * ex: 'name' become 'data.name'
   */
  _dataKey: (key) => `data.${key}`,

  /**
   * Returns the modified selector key to comform data key
   * Ex: selector: {name: 'Mario'} wil become selector: {'data.name': 'Mario'}
   */
  _buildSelector: function(selector) {
    const dataSelector = {};
    const selectorKeys = [];

    for (let key in selector) {
      if(selector.hasOwnProperty(key)){
        selectorKeys.push(key);
      }
    }

    selectorKeys.forEach(function(key) {
      const dataKey = this._dataKey(key);
      dataSelector[dataKey] = selector[key];
    }.bind(this));

    return dataSelector;
  },

  /**
   * Returns the modified sort key
   * Ex: sort: ['series'] will become ['data.series']
   * Ex: sort: [{series: 'desc'}] will became [{'data.series': 'desc'}]
   */
  _buildSort: function(sort) {
    return sort.map(function (value) {
      const sortKey = {};
      if (typeof value === 'object' && value !== null) {
        for (let key in value) {
          if(value.hasOwnProperty(key)){
            sortKey[this._dataKey(key)] = value[key];
          }
        }
      } else {
        return this._dataKey(value);
      }
      return sortKey;
    }.bind(this));
  },

  /**
   * Returns the string to use for the model name part of the PouchDB document
   * ID for records of the given ember-data type.
   *
   * This method uses the camelized version of the model name in order to
   * preserve data compatibility with older versions of ember-pouch. See
   * pouchdb-community/ember-pouch#63 for a discussion.
   *
   * You can override this to change the behavior. If you do, be aware that you
   * need to execute a data migration to ensure that any existing records are
   * moved to the new IDs.
   */
  getRecordTypeName(type) {
    return camelize(type.modelName);
  },

  findAllCount: 1,
  findAll: function(store, type, _neverSet, snapshotRecordArray) {
    this._init(store, type);
    const startTime = Date.now();
    const recordTypeName = this.getRecordTypeName(type);
    const count = this.findAllCount++;
    console.log(`findAll (count=${count}, recordTypeName=${recordTypeName})`, snapshotRecordArray.snapshots().map(sar => sar._internalModel.currentState.stateName)); // eslint-disable-line no-console
    //debugger;
    const p1 = this.get('db').rel.find(recordTypeName);
    p1.then(() => console.log(`rel.find took ${Date.now()-startTime}ms`)); // eslint-disable-line no-console
    //const p2 = p1.then((...args) => {
    //  return new Promise((resolve) => later(null, () => resolve(...args), 10)); // FIXME: inserting a delay here circumvents the problem
    //});
    p1.then((...args) => {
      console.log(`findAll (count=${count}) finished:`, ...args, snapshotRecordArray.snapshots().map(sar => sar._internalModel.currentState.stateName)); // eslint-disable-line no-console
      console.log(args[0]);
    });
    return p1.then((data) => {
      const states = snapshotRecordArray.snapshots().map(sar => sar._internalModel.currentState.stateName);
      if (states.some(s => s.includes('deleted.inFlight'))) {
        //throw Error(`Records appear to have been deleted between calling pouch adapter's findAll and its underlying tasks finishing`);
        const plural = pluralize(recordTypeName);
        data[plural] = data[plural].filter((_r, i) => !states[i].includes('deleted.inFlight'));
      }
      return data;
    });
  },

  findMany: function(store, type, ids) {
    console.log('findMany', type, ids); // eslint-disable-line no-console
    this._init(store, type);
    return this.get('db').rel.find(this.getRecordTypeName(type), ids);
  },

  findHasMany: function(store, record, link, rel) {
    console.log('findHasMany', record, link, rel); // eslint-disable-line no-console
    let inverse = record.type.inverseFor(rel.key, store);
    if (inverse && inverse.kind === 'belongsTo') {
      return this.get('db').rel.findHasMany(camelize(rel.type), inverse.name, record.id);
    } else {
      let result = {};
      result[pluralize(rel.type)] = [];
      return result; //data;
    }
  },

  query: function(store, type, query) {
    console.log('query', type, query); // eslint-disable-line no-console
    this._init(store, type);

    const recordTypeName = this.getRecordTypeName(type);
    const db = this.get('db');

    const queryParams = {
      selector: this._buildSelector(query.filter)
    };

    if (!isEmpty(query.sort)) {
      queryParams.sort = this._buildSort(query.sort);
    }

    if (!isEmpty(query.limit)) {
      queryParams.limit = query.limit;
    }

    if (!isEmpty(query.skip)) {
      queryParams.skip = query.skip;
    }

    return db.find(queryParams).then(pouchRes => db.rel.parseRelDocs(recordTypeName, pouchRes.docs));
  },

  queryRecord: function(store, type, query) {
    console.log('queryRecord', type, query); // eslint-disable-line no-console
    return this.query(store, type, query).then(results => {
      const recordType = this.getRecordTypeName(type);
      const recordTypePlural = pluralize(recordType);
      if(results[recordTypePlural].length > 0){
        results[recordType] = results[recordTypePlural][0];
      } else {
        results[recordType] = null;
      }
      delete results[recordTypePlural];
      return results;
    });
  },

  /**
   * `find` has been deprecated in ED 1.13 and is replaced by 'new store
   * methods', see: https://github.com/emberjs/data/pull/3306
   * We keep the method for backward compatibility and forward calls to
   * `findRecord`. This can be removed when the library drops support
   * for deprecated methods.
  */
  find: function (store, type, id) {
    console.log('find', type, id); // eslint-disable-line no-console
    return this.findRecord(store, type, id);
  },

  findRecord: function (store, type, id) {
    console.log('findRecord', type, id); // eslint-disable-line no-console
    this._init(store, type);
    const recordTypeName = this.getRecordTypeName(type);
    return this._findRecord(recordTypeName, id);
  },

  _findRecord(recordTypeName, id) {
    console.log('_findRecord', recordTypeName, id); // eslint-disable-line no-console
    const promise = this.get('db').rel.find(recordTypeName, id).then(payload => {
      // Ember Data chokes on empty payload, this function throws
      // an error when the requested data is not found
      if (typeof payload === 'object' && payload !== null) {
        const singular = recordTypeName;
        const plural = pluralize(recordTypeName);

        const results = payload[singular] || payload[plural];
        if (results && results.length > 0) {
          return payload;
        }
      }

      if (configFlagDisabled(this, 'eventuallyConsistent'))
        throw new Error("Document of type '" + recordTypeName + "' with id '" + id + "' not found.");
      else
        return this._eventuallyConsistent(recordTypeName, id);
    });
    promise.then(() => {
      console.log('_findRecord finished'); // eslint-disable-line no-console
    });
    return promise;
  },

  //TODO: cleanup promises on destroy or db change?
  waitingForConsistency: null,
  _eventuallyConsistent: function(type, id) {
    let pouchID = this.get('db').rel.makeDocID({type, id});
    let defer = RSVP.defer();
    this.waitingForConsistency[pouchID] = defer;

    return this.get('db').rel.isDeleted(type, id).then(deleted => {
      console.log(`_eventuallyConsistent > isDeleted`, deleted); // eslint-disable-line no-console
      //TODO: should we test the status of the promise here? Could it be handled in onChange already?
      if (deleted) {
        delete this.waitingForConsistency[pouchID];
        throw new Error("Document of type '" + type + "' with id '" + id + "' is deleted.");
      } else if (deleted === null) {
        return defer.promise;
      } else {
        assert('Status should be existing', deleted === false);
        //TODO: should we reject or resolve the promise? or does JS GC still clean it?
        if (this.waitingForConsistency[pouchID]) {
          delete this.waitingForConsistency[pouchID];
          return this._findRecord(type, id);
        } else {
          //findRecord is already handled by onChange
          return defer.promise;
        }
      }
    });
  },

  generateIdForRecord: function(/* store, type, inputProperties */) {
    return v4();
  },

  createdRecords: null,
  createRecord: function(store, type, snapshot) {
    const record = snapshot.record;
    if (record._emberPouchSavePromise) {
      const changes = record.changedAttributes();
      record._emberPouchSavePromise = record._emberPouchSavePromise.then(records => {
        // If there have been changes since the document was created then we should update the record now
        if (Object.keys(changes).length > 0) {
          const rev = records[Object.keys(records)[0]][0].rev;
          (snapshot.__attributes || snapshot._attributes).rev = rev; // FIXME: it should be possible to do this elsewhere
          return this.updateRecord(store, type, snapshot);
        }
        return records;
      });
      return record._emberPouchSavePromise;
    }

    this._init(store, type);
    const data = this._recordToData(store, type, snapshot);
    const rel = this.get('db').rel;
    const id = data.id;
    this.createdRecords[id] = true;
    Object.defineProperty(record, '_emberPouchSavePromise', {
      enumerable: false,
      writable: true,
      value: rel.save(this.getRecordTypeName(type), data).catch((e) => {
        delete this.createdRecords[id];
        throw e;
      }),
    });
    return record._emberPouchSavePromise;
  },

  /**
   * This method is invoked when `updateRecord` is subsequently called for the same ID before previous transactions
   * have completed (i.e. when an update conflict would have otherwise occurred).
   * If there is only one application instance interacting with the database then the store
   * should have all the latest changes already and no special merging should be needed here.
   * Thus, by default, this function just applies the latest revision code and overwrites any existing
   * contents with that present in the document passed to `updateRecord`.
   * @param dbDoc Latest content persisted to database
   * @param reqDoc Content requested to be persisted (whatever was passed to `updateRecord`).
   * @return Content to persist (result of merge/resolution)
   */
  handleUpdateConflict(dbDoc, reqDoc) {
    reqDoc.rev = dbDoc._rev;
    return reqDoc;
  },

  updateRecord: function (store, type, snapshot) {
    this._updateCounter = (this._updateCounter || 0) + 1;
    const thisUpdateCounter = this._updateCounter;
    this._init(store, type);
    let data = this._recordToData(store, type, snapshot);
    console.log(`updateRecord: thisUpdateCounter = ${thisUpdateCounter}, id=${data.id}, rev=${data.rev}`); // eslint-disable-line no-console

    // If there's a pending update on this same ID then a "Document update conflict" error is going to be thrown
    // by the back-end unless we do something to prevent it since both updates would be specifying the same base rev.
    // The data structure we use here to avoid these conflicts works as follows:
    //   1. A map object associates document IDs with arrays of pending updates, each represented by a promise
    //   2. If the array is not empty when a new update starts, it gets deferred
    //      until all pending update have finished. Otherwise it begins immediately.
    //   3. Whenever an update finishes it is removed from the array.
    //   4. In the case of deferral, the `handleUpdateConflict` function is called once it is time to execute
    //      the next update, and the returned value is passed to the back-end (and if that function has done its job
    //      then no update conflict will occur).
    this._updatesInProgress = this._updatesInProgress || {}; // map of arrays of pending update promises for each document ID
    this._updatesInProgress[data.id] = this._updatesInProgress[data.id] || [];
    const promise = Promise.resolve().then(() => {
      // being extra careful because otherwise it's easy to accidentally deadlock (waiting for yourself)
      const pending = Object.freeze(Array.from(this._updatesInProgress[data.id]));
      let previousUpdates = Promise.all(pending);
      if (pending.length > 0) {
        // There is at least one pending update for this ID so add another piece to the promise chain to get the latest rev
        console.log(`updateRecord: going to chain onto previousUpdates =`, previousUpdates); // eslint-disable-line no-console
        previousUpdates = previousUpdates.then(() => {
          const docID = this.db.rel.makeDocID({ type: type.modelName, id: data.id });
          console.log('updateRecord: retrieving latest rev from DB', docID); // eslint-disable-line no-console
          return this.db.get(docID);
        }).then(dbDoc => {
          const rev = dbDoc._rev;
          console.log(`updateRecord: DB has latest rev = ${rev}`); // eslint-disable-line no-console
          const update = data;
          data = this.handleUpdateConflict(dbDoc, update);
          console.log('updateRecord: handleUpdateConflict: dbDoc =', dbDoc, ` (rev=${rev}), update =`, update, ` (rev=${update.rev}), resolved with result =`, data, `(rev=${data.rev})`); // eslint-disable-line no-console
        });
      }

      // Track pending updates
      // Since JS is single threaded and updates are deferred until previous ones are done, we should be able to safely
      // assume that the update promises will be resolved in order (can just remove done ones from the from the front
      // and append pending ones to the back)
      this._updatesInProgress[data.id].push(promise);
      promise.finally(() => {
        console.log(`updateRecord removing completed entry from _updatesInProgress[${data.id}]`); // eslint-disable-line no-console
        // Important for maintaining data structure integrity/correctness
        this._updatesInProgress[data.id].shift();
      });

      //console.log('updateRecord: waiting for previous updates', previousUpdates); // eslint-disable-line no-console
      return previousUpdates.then(() => this.get('db').rel.save(this.getRecordTypeName(type), data));
    });


    // DEBUG
    promise.then((...args) => {
      console.log(`updateRecord finished successfully (thisUpdateCounter=${thisUpdateCounter})`, ...args); // eslint-disable-line no-console
    }).catch(e => {
      console.error(`updateRecord FAILED (thisUpdateCounter=${thisUpdateCounter})`, e, data); // eslint-disable-line no-console
    });


    return promise;
  },

  deleteRecord: function (store, type, record) {
    this._deleteCounter = (this._deleteCounter || 0) + 1;
    const thisDeleteCounter = this._deleteCounter;
    this._init(store, type);
    const data = this._recordToData(store, type, record);
    console.log(`deleteRecord (count=${this._deleteCounter})`, data); // eslint-disable-line no-console
    const promise = this.get('db').rel.del(this.getRecordTypeName(type), data)
      .then(extractDeleteRecord);
    promise.then((...args) => {
      console.log(`deleteRecord finished successfully (thisDeleteCounter=${thisDeleteCounter})`, ...args); // eslint-disable-line no-console
    }).catch(e => {
      console.error(`deleteRecord FAILED (thisDeleteCounter=${thisDeleteCounter})`, e, data); // eslint-disable-line no-console
      //debugger;
    });
    return promise;

  }
});
