var ByteBuffer = require("bytebuffer");
var crypto = require('crypto');
var async = require('async');
var ed = require('../utils/ed.js');
var constants = require('../utils/constants.js');
var slots = require('../utils/slots.js');
var Router = require('../utils/router.js');
var TransactionTypes = require('../utils/transaction-types.js');
var sandboxHelper = require('../utils/sandbox.js');
var addressHelper = require('../utils/address.js')

var genesisblock = null;
// Private fields
var modules, library, self, private = {}, shared = {};

private.unconfirmedNumber = 0;
private.unconfirmedTransactions = [];
private.unconfirmedTransactionsIdIndex = {};

class TransactionPool {
  constructor() {
    this.index = new Map
    this.unConfirmed = new Array
  }

  add(trs) {
    this.unConfirmed.push(trs)
    this.index.set(trs.id, this.unConfirmed.length - 1)
  }

  remove(id) {
    let pos = this.index.get(id)
    delete this.index[id]
    this.unConfirmed[pos] = null
  }

  has(id) {
    let pos = this.index.get(id)
    return pos !== undefined && !!this.unConfirmed[pos]
  }

  getUnconfirmed() {
    var a = [];

    for (var i = 0; i < this.unConfirmed.length; i++) {
      if (!!this.unConfirmed[i]) {
        a.push(this.unConfirmed[i]);
      }
    }
    return a
  }

  clear() {
    this.index = new Map
    this.unConfirmed = new Array
  }

  get(id) {
    let pos = this.index.get(id)
    return this.unConfirmed[pos]
  }
}

function Transfer() {
  this.create = function (data, trs) {
    trs.recipientId = data.recipientId;
    trs.amount = data.amount;

    return trs;
  }

  this.calculateFee = function (trs, sender) {
    return library.base.block.calculateFee();
  }

  this.verify = function (trs, sender, cb) {
    if (!addressHelper.isAddress(trs.recipientId)) {
      return cb("Invalid recipient");
    }

    if (trs.amount <= 0) {
      return cb("Invalid transaction amount");
    }

    if (trs.recipientId == sender.address) {
      return cb("Invalid recipientId, cannot be your self");
    }

    if (!global.featureSwitch.enableMoreLockTypes) {
      var lastBlock = modules.blocks.getLastBlock()
      if (sender.lockHeight && lastBlock && lastBlock.height + 1 <= sender.lockHeight) {
        return cb('Account is locked')
      }
    }

    cb(null, trs);
  }

  this.process = function (trs, sender, cb) {
    setImmediate(cb, null, trs);
  }

  this.getBytes = function (trs) {
    return null;
  }

  this.apply = function (trs, block, sender, cb) {
    modules.accounts.setAccountAndGet({ address: trs.recipientId }, function (err, recipient) {
      if (err) {
        return cb(err);
      }

      modules.accounts.mergeAccountAndGet({
        address: trs.recipientId,
        balance: trs.amount,
        u_balance: trs.amount,
        blockId: block.id,
        round: modules.round.calc(block.height)
      }, function (err) {
        cb(err);
      });
    });
  }

  this.undo = function (trs, block, sender, cb) {
    modules.accounts.setAccountAndGet({ address: trs.recipientId }, function (err, recipient) {
      if (err) {
        return cb(err);
      }

      modules.accounts.mergeAccountAndGet({
        address: trs.recipientId,
        balance: -trs.amount,
        u_balance: -trs.amount,
        blockId: block.id,
        round: modules.round.calc(block.height)
      }, function (err) {
        cb(err);
      });
    });
  }

  this.applyUnconfirmed = function (trs, sender, cb) {
    setImmediate(cb);
  }

  this.undoUnconfirmed = function (trs, sender, cb) {
    setImmediate(cb);
  }

  this.objectNormalize = function (trs) {
    delete trs.blockId;
    return trs;
  }

  this.dbRead = function (raw) {
    return null;
  }

  this.dbSave = function (trs, cb) {
    setImmediate(cb);
  }

  this.ready = function (trs, sender) {
    if (sender.multisignatures.length) {
      if (!trs.signatures) {
        return false;
      }

      return trs.signatures.length >= sender.multimin - 1;
    } else {
      return true;
    }
  }
}

function Storage() {
  this.create = function (data, trs) {
    trs.asset.storage = {
      content: Buffer.isBuffer(data.content) ? data.content.toString('hex') : data.content
    }

    return trs;
  }

  this.calculateFee = function (trs, sender) {
    var binary = Buffer.from(trs.asset.storage.content, 'hex');
    return (Math.floor(binary.length / 200) + 1) * library.base.block.calculateFee();
  }

  this.verify = function (trs, sender, cb) {
    if (!trs.asset.storage || !trs.asset.storage.content) {
      return cb('Invalid transaction asset');
    }
    if (new Buffer(trs.asset.storage.content, 'hex').length > 4096) {
      return cb('Invalid storage content size');
    }

    cb(null, trs);
  }

  this.process = function (trs, sender, cb) {
    setImmediate(cb, null, trs);
  }

  this.getBytes = function (trs) {
    return ByteBuffer.fromHex(trs.asset.storage.content).toBuffer();
  }

  this.apply = function (trs, block, sender, cb) {
    setImmediate(cb);
  }

  this.undo = function (trs, block, sender, cb) {
    setImmediate(cb);
  }

  this.applyUnconfirmed = function (trs, sender, cb) {
    setImmediate(cb);
  }

  this.undoUnconfirmed = function (trs, sender, cb) {
    setImmediate(cb);
  }

  this.objectNormalize = function (trs) {
    var report = library.scheme.validate(trs.asset.storage, {
      type: "object",
      properties: {
        content: {
          type: "string",
          format: "hex"
        }
      },
      required: ['content']
    });

    if (!report) {
      throw Error('Invalid storage parameters: ' + library.scheme.getLastError());
    }

    return trs;
  }

  this.dbRead = function (raw) {
    if (!raw.st_content) {
      return null;
    } else {
      var storage = {
        content: raw.st_content
      }

      return { storage: storage };
    }
  }

  this.dbSave = function (trs, cb) {
    try {
      var content = new Buffer(trs.asset.storage.content, 'hex');
    } catch (e) {
      return cb(e.toString())
    }

    library.dbLite.query("INSERT INTO storages(transactionId, content) VALUES($transactionId, $content)", {
      transactionId: trs.id,
      content: content
    }, cb);
  }

  this.ready = function (trs, sender) {
    if (sender.multisignatures.length) {
      if (!trs.signatures) {
        return false;
      }

      return trs.signatures.length >= sender.multimin - 1;
    } else {
      return true;
    }
  }
}

function Lock() {
  this.create = function (data, trs) {
    trs.args = data.args

    return trs;
  }

  this.calculateFee = function (trs, sender) {
    return library.base.block.calculateFee();
  }

  this.verify = function (trs, sender, cb) {
    if (trs.args.length > 1) return cb('Invalid args length')
    if (trs.args[0].length > 50) return cb('Invalid lock height')
    var lockHeight = Number(trs.args[0])

    var lastBlock = modules.blocks.getLastBlock()

    if (isNaN(lockHeight) || lockHeight <= lastBlock.height) return cb('Invalid lock height')
    if (global.featureSwitch.enableLockReset) {
      if (sender.lockHeight && lastBlock.height + 1 <= sender.lockHeight && lockHeight <= sender.lockHeight) return cb('Account is already locked at height ' + sender.lockHeight)
    } else {
      if (sender.lockHeight && lastBlock.height + 1 <= sender.lockHeight) return cb('Account is already locked at height ' + sender.lockHeight)
    }

    cb(null, trs);
  }

  this.process = function (trs, sender, cb) {
    setImmediate(cb, null, trs);
  }

  this.getBytes = function (trs) {
    return null
  }

  this.apply = function (trs, block, sender, cb) {
    library.base.account.set(sender.address, { u_multimin: sender.lockHeight }, function (err) {
      if (err) return cb('Failed to backup lockHeight')
      library.base.account.set(sender.address, { lockHeight: Number(trs.args[0]) }, cb)
    })
  }

  this.undo = function (trs, block, sender, cb) {
    library.logger.warn('undo lock height', {
      trs: trs,
      sender: sender
    })
    library.base.account.set(sender.address, { lockHeight: sender.u_multimin }, cb)
  }

  this.applyUnconfirmed = function (trs, sender, cb) {
    var key = sender.address + ':' + trs.type
    if (library.oneoff.has(key)) {
      return setImmediate(cb, 'Double submit')
    }
    library.oneoff.set(key, true)
    setImmediate(cb)
  }

  this.undoUnconfirmed = function (trs, sender, cb) {
    var key = sender.address + ':' + trs.type
    library.oneoff.delete(key)
    setImmediate(cb)
  }

  this.objectNormalize = function (trs) {
    return trs;
  }

  this.dbRead = function (raw) {
    return null;
  }

  this.dbSave = function (trs, cb) {
    setImmediate(cb);
  }

  this.ready = function (trs, sender) {
    if (sender.multisignatures.length) {
      if (!trs.signatures) {
        return false;
      }

      return trs.signatures.length >= sender.multimin - 1;
    } else {
      return true;
    }
  }
}

// Constructor
function Transactions(cb, scope) {
  library = scope;
  genesisblock = library.genesisblock;
  self = this;
  self.__private = private;
  self.pool = new TransactionPool()
  private.attachApi();

  library.base.transaction.attachAssetType(TransactionTypes.SEND, new Transfer());
  library.base.transaction.attachAssetType(TransactionTypes.STORAGE, new Storage());
  library.base.transaction.attachAssetType(TransactionTypes.LOCK, new Lock());

  setImmediate(cb, null, self);
}

// Private methods
private.attachApi = function () {
  var router = new Router();

  router.use(function (req, res, next) {
    if (modules) return next();
    res.status(500).send({ success: false, error: "Blockchain is loading" });
  });

  router.map(shared, {
    "get /": "getTransactions",
    "get /get": "getTransaction",
    "get /unconfirmed/get": "getUnconfirmedTransaction",
    "get /unconfirmed": "getUnconfirmedTransactions",
    "put /": "addTransactionUnsigned"
  });

  router.use(function (req, res, next) {
    res.status(500).send({ success: false, error: "API endpoint not found" });
  });

  library.network.app.use('/api/transactions', router);
  library.network.app.use(function (err, req, res, next) {
    if (!err) return next();
    library.logger.error(req.url, err.toString());
    res.status(500).send({ success: false, error: err.toString() });
  });

  private.attachStorageApi();
}

private.attachStorageApi = function () {
  var router = new Router();

  router.use(function (req, res, next) {
    if (modules) return next();
    res.status(500).send({ success: false, error: "Blockchain is loading" });
  });

  router.map(shared, {
    "get /get": "getStorage",
    "get /:id": "getStorage",
    "put /": "putStorage"
  });

  router.use(function (req, res, next) {
    res.status(500).send({ success: false, error: "API endpoint not found" });
  });

  library.network.app.use('/api/storages', router);
  library.network.app.use(function (err, req, res, next) {
    if (!err) return next();
    library.logger.error(req.url, err.toString());
    res.status(500).send({ success: false, error: err.toString() });
  });
}

private.list = function (filter, cb) {
  var sortFields = ['t.id', 't.blockId', 't.amount', 't.fee', 't.type', 't.timestamp', 't.senderPublicKey', 't.senderId', 't.recipientId', 't.confirmations', 'b.height'];
  var params = {}, fields_or = [], owner = "";
  if (filter.blockId) {
    fields_or.push('blockId = $blockId')
    params.blockId = filter.blockId;
  }
  if (filter.senderPublicKey) {
    fields_or.push('lower(hex(senderPublicKey)) = $senderPublicKey')
    params.senderPublicKey = filter.senderPublicKey;
  }
  if (filter.senderId) {
    fields_or.push('senderId = $senderId');
    params.senderId = filter.senderId;
  }
  if (filter.recipientId) {
    fields_or.push('recipientId = $recipientId')
    params.recipientId = filter.recipientId;
  }
  if (filter.ownerAddress && filter.ownerPublicKey) {
    owner = '(lower(hex(senderPublicKey)) = $ownerPublicKey or recipientId = $ownerAddress)';
    params.ownerPublicKey = filter.ownerPublicKey;
    params.ownerAddress = filter.ownerAddress;
  } else if (filter.ownerAddress) {
    owner = '(senderId = $ownerAddress or recipientId = $ownerAddress)';
    params.ownerAddress = filter.ownerAddress;
  }
  if (filter.type >= 0) {
    fields_or.push('type = $type');
    params.type = filter.type;
  }
  if (filter.uia) {
    fields_or.push('(type >=9 and type <= 14)')
  }

  if (filter.message) {
    fields_or.push('message = $message')
    params.message = filter.message
  }

  if (filter.limit) {
    params.limit = filter.limit;
  } else {
    params.limit = filter.limit = 20;
  }

  if (filter.offset >= 0) {
    params.offset = filter.offset;
  }

  if (filter.orderBy) {
    var sort = filter.orderBy.split(':');
    var sortBy = sort[0].replace(/[^\w_]/gi, '').replace('_', '.');
    if (sort.length == 2) {
      var sortMethod = sort[1] == 'desc' ? 'desc' : 'asc'
    } else {
      sortMethod = "desc";
    }
  }

  if (sortBy) {
    if (sortFields.indexOf(sortBy) < 0) {
      return cb("Invalid sort field");
    }
  }

  var uiaCurrencyJoin = ''
  if (filter.currency) {
    uiaCurrencyJoin = 'inner join transfers ut on ut.transactionId = t.id and ut.currency = "' + filter.currency + '" '
  }

  var connector = "or";
  if (filter.and) {
    connector = "and";
  }

  library.dbLite.query("select count(t.id) " +
    "from trs t " +
    "inner join blocks b on t.blockId = b.id " + uiaCurrencyJoin +
    (fields_or.length || owner ? "where " : "") + " " +
    (fields_or.length ? "(" + fields_or.join(' ' + connector + ' ') + ") " : "") + (fields_or.length && owner ? " and " + owner : owner), params, { "count": Number }, function (err, rows) {
      if (err) {
        return cb(err);
      }

      var count = rows.length ? rows[0].count : 0;

      // Need to fix 'or' or 'and' in query
      library.dbLite.query("select t.id, b.height, t.blockId, t.type, t.timestamp, lower(hex(t.senderPublicKey)), t.senderId, t.recipientId, t.amount, t.fee, lower(hex(t.signature)), lower(hex(t.signSignature)), t.signatures, t.args, t.message, (select max(height) + 1 from blocks) - b.height " +
        "from trs t " +
        "inner join blocks b on t.blockId = b.id " + uiaCurrencyJoin +
        (fields_or.length || owner ? "where " : "") + " " +
        (fields_or.length ? "(" + fields_or.join(' ' + connector + ' ') + ") " : "") + (fields_or.length && owner ? " and " + owner : owner) + " " +
        (filter.orderBy ? 'order by ' + sortBy + ' ' + sortMethod : '') + " " +
        (filter.limit ? 'limit $limit' : '') + " " +
        (filter.offset ? 'offset $offset' : ''), params, ['t_id', 'b_height', 't_blockId', 't_type', 't_timestamp', 't_senderPublicKey', 't_senderId', 't_recipientId', 't_amount', 't_fee', 't_signature', 't_signSignature', 't_signatures', 't_args', 't_message', 'confirmations'], function (err, rows) {
          if (err) {
            return cb(err);
          }

          var transactions = [];
          for (var i = 0; i < rows.length; i++) {
            transactions.push(library.base.transaction.dbRead(rows[i]));
          }
          var data = {
            transactions: transactions,
            count: count
          }
          cb(null, data);
        });
    });
}

private.getById = function (id, cb) {
  library.dbLite.query("select t.id, b.height, t.blockId, t.type, t.timestamp, lower(hex(t.senderPublicKey)), t.senderId, t.recipientId, t.amount, t.fee, lower(hex(t.signature)), lower(hex(t.signSignature)), t.args, t.message, (select max(height) + 1 from blocks) - b.height " +
    "from trs t " +
    "inner join blocks b on t.blockId = b.id " +
    "where t.id = $id", { id: id }, ['t_id', 'b_height', 't_blockId', 't_type', 't_timestamp', 't_senderPublicKey', 't_senderId', 't_recipientId', 't_amount', 't_fee', 't_signature', 't_signSignature', 't_args', 't_message', 'confirmations'], function (err, rows) {
      if (err || !rows.length) {
        return cb(err || "Can't find transaction: " + id);
      }

      var transaction = library.base.transaction.dbRead(rows[0]);
      cb(null, transaction);
    });
}

Transactions.prototype.getUnconfirmedTransaction = function (id) {
  return self.pool.get(id)
}

Transactions.prototype.getUnconfirmedTransactionList = function () {
  return self.pool.getUnconfirmed()
}

Transactions.prototype.removeUnconfirmedTransaction = function (id) {
  self.pool.remove(id)
}

Transactions.prototype.hasUnconfirmed = function (id) {
  return self.pool.has(id)
}

Transactions.prototype.clearUnconfirmed = function () {
  self.pool.clear()
}

Transactions.prototype.getUnconfirmedTransactions = function (_, cb) {
  setImmediate(cb, null, { transactions: self.getUnconfirmedTransactionList() })
}

Transactions.prototype.getTransactions = function (req, cb) {
  let limit = Number(req.query.limit) || 100
  let offset = Number(req.query.offset) || 0
  let condition = {}
  if (req.query.senderId) {
    condition.senderId = req.query.senderId
  }
  if (req.query.type) {
    condition.type = Number(req.query.type)
  }

  (async () => {
    try {
      let count = await app.model.Transaction.count(condition)
      let transactions = await app.model.Transaction.findAll({
        condition: condition,
        limit: limit,
        offset: offset
      })
      if (!transactions) transactions = []
      return cb(null, { transactions: transactions, count: count })
    } catch (e) {
      app.logger.error('Failed to get transactions', e)
      return cb('System error: ' + e)
    }
  })()
}

Transactions.prototype.getTransaction = function (req, cb) {
  (async function () {
    try {
      if (!req.params || !req.params.id) return cb('Invalid transaction id')
      let id = req.params.id
      let trs = await app.model.Transaction.findOne({
        condition: {
          id: id
        }
      })
      if (!trs) return cb('Transaction not found')
      return cb(null, { transaction: trs })
    } catch (e) {
      return cb('System error: ' + e)
    }
  })()
}

Transactions.prototype.receiveTransactions = function (transactions, cb) {
  (async function () {
    try {
      for (let i = 0; i < transactions.length; ++i) {
        await self.processUnconfirmedTransactionAsync(transactions[i])
      }
    } catch (e) {
      return cb(e)
    }
    cb(null, transactions)
  })()
}

Transactions.prototype.receiveTransactionsAsync = async function (transactions) {
  for (let i = 0; i < transactions.length; ++i) {
    await self.processUnconfirmedTransactionAsync(transactions[i])
  }
}

Transactions.prototype.processUnconfirmedTransactionAsync = async function (transaction, broadcast) {
  if (!transaction) {
    return cb("No transaction to process!");
  }
  library.logger.debug('process unconfirmed trs', transaction)
  if (!transaction.id) {
    transaction.id = library.base.transaction.getId(transaction);
  }

  if (self.pool.has(transaction.id)) {
    throw new Error('Transaction already processed')
  }

  // FIXME
  if (!transaction.senderId) {
    transaction.senderId = modules.accounts.generateAddressByPublicKey(transaction.senderPublicKey)
  }
  let height = modules.blocks.getLastBlock().height

  let sender = await app.model.Account.findOne({ condition: { address: transaction.senderId } })
  if (!sender) throw new Error('Sender account not found')

  if (height > 0) {
    let error = library.base.transaction.verify(transaction, sender)
    if (error) throw new Error(error)
  }

  let exists = await app.model.Transaction.exists({ id: transaction.id })
  if (exists) {
    throw new Error('Transaction already confirmed')
  }

  let block = {
    height: height,
  }

  try {
    await library.base.transaction.apply(transaction, block)
  } catch (e) {
    library.logger.error(e)
    app.sdb.rollbackTransaction()
    throw e
  }

  if (broadcast) {
    library.bus.message('unconfirmedTransaction', transaction, true);
  }

  self.pool.add(transaction)
  return transaction
}

Transactions.prototype.addTransactionUnsigned = function (transaction, cb) {
  shared.addTransactionUnsigned({ body: transaction }, cb)
}

Transactions.prototype.sandboxApi = function (call, args, cb) {
  sandboxHelper.callMethod(shared, call, args, cb);
}

Transactions.prototype.list = function (query, cb) {
  private.list(query, cb)
}

Transactions.prototype.getById = function (id, cb) {
  private.getById(id, cb)
}

// Events
Transactions.prototype.onBind = function (scope) {
  modules = scope;
}

// Shared
shared.getTransactions = function (req, cb) {
  var query = req.body;
  library.scheme.validate(query, {
    type: "object",
    properties: {
      blockId: {
        type: "string"
      },
      limit: {
        type: "integer",
        minimum: 0,
        maximum: 100
      },
      type: {
        type: "integer",
        minimum: 0,
        maximum: 100
      },
      orderBy: {
        type: "string"
      },
      offset: {
        type: "integer",
        minimum: 0
      },
      senderPublicKey: {
        type: "string",
        format: "publicKey"
      },
      ownerPublicKey: {
        type: "string",
        format: "publicKey"
      },
      ownerAddress: {
        type: "string"
      },
      senderId: {
        type: "string"
      },
      recipientId: {
        type: "string"
      },
      amount: {
        type: "integer",
        minimum: 0,
        maximum: constants.fixedPoint
      },
      fee: {
        type: "integer",
        minimum: 0,
        maximum: constants.fixedPoint
      },
      uia: {
        type: "integer",
        minimum: 0,
        maximum: 1
      },
      currency: {
        type: "string",
        minimum: 1,
        maximum: 22
      },
      and: {
        type: "integer",
        minimum: 0,
        maximum: 1
      }
    }
  }, function (err) {
    if (err) {
      return cb(err[0].message);
    }

    (async function () {
      let transactions = await app.model.Transaction.findAll({ limit: 20 })
    })()
    private.list(query, function (err, data) {
      if (err) {
        return cb("Failed to get transactions");
      }

      cb(null, { transactions: data.transactions, count: data.count });
    });
  });
}

shared.getTransaction = function (req, cb) {
  var query = req.body;
  library.scheme.validate(query, {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        minLength: 1
      }
    },
    required: ['id']
  }, function (err) {
    if (err) {
      return cb(err[0].message);
    }

    private.getById(query.id, function (err, transaction) {
      if (!transaction || err) {
        return cb("Transaction not found");
      }
      cb(null, { transaction: transaction });
    });
  });
}

shared.getUnconfirmedTransaction = function (req, cb) {
  var query = req.body;
  library.scheme.validate(query, {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        minLength: 1,
        maxLength: 64
      }
    },
    required: ['id']
  }, function (err) {
    if (err) {
      return cb(err[0].message);
    }

    var unconfirmedTransaction = self.getUnconfirmedTransaction(query.id);

    if (!unconfirmedTransaction) {
      return cb("Transaction not found");
    }

    cb(null, { transaction: unconfirmedTransaction });
  });
}

shared.getUnconfirmedTransactions = function (req, cb) {
  var query = req.body;
  library.scheme.validate(query, {
    type: "object",
    properties: {
      senderPublicKey: {
        type: "string",
        format: "publicKey"
      },
      address: {
        type: "string"
      }
    }
  }, function (err) {
    if (err) {
      return cb(err[0].message);
    }

    var transactions = self.getUnconfirmedTransactionList(true),
      toSend = [];

    if (query.senderPublicKey || query.address) {
      for (var i = 0; i < transactions.length; i++) {
        if (transactions[i].senderPublicKey == query.senderPublicKey || transactions[i].recipientId == query.address) {
          toSend.push(transactions[i]);
        }
      }
    } else {
      for (var i = 0; i < transactions.length; i++) {
        toSend.push(transactions[i]);
      }
    }

    cb(null, { transactions: toSend });
  });
}

shared.addTransaction = function (req, cb) {
  let query = req.body
  library.sequence.add(function addTransaction(cb) {
    (async function () {
      try {
        var trs = await self.processUnconfirmedTransactionAsync(query.transaction, true)
        cb(null, { transactionId: trs.id })
      } catch (e) {
        cb(e.toString())
      }
    })()
  }, cb)
}

shared.addTransactionUnsigned = function (req, cb) {
  let query = req.body
  if (query.type) {
    query.type = Number(query.type)
  }
  let valid = library.scheme.validate(query, {
    type: 'object',
    properties: {
      secret: { type: 'string', maxLength: 100 },
      fee: { type: 'integer', min: 1 },
      type: { type: 'integer', min: 1 },
      args: { type: 'array' },
      message: { type: 'string', maxLength: 50 }
    },
    required: ['secret', 'fee', 'type']
  })
  if (!valid) {
    library.logger.warn('Failed to validate query params', library.scheme.getLastError())
    return setImmediate(cb, library.scheme.getLastError().details[0].message)
  }
  library.sequence.add(function addTransactionUnsigned(cb) {
    (async function () {
      try {
        let hash = crypto.createHash('sha256').update(query.secret, 'utf8').digest();
        let keypair = ed.MakeKeypair(hash);
        let secondKeyPair = null
        if (query.secondSecret) {
          secondKeyPair = ed.MakeKeypair(crypto.createHash('sha256').update(query.secondSecret, 'utf8').digest())
        }
        let trs = library.base.transaction.create({
          secret: query.secret,
          fee: query.fee,
          type: query.type,
          args: query.args || null,
          message: query.message || null,
          secondKeyPair: secondKeyPair,
          keypair: keypair
        })
        await self.processUnconfirmedTransactionAsync(trs, true)
        cb(null, { transactionId: trs.id })
      } catch (e) {
        library.logger.warn('Failed to process unsigned transaction', e)
        cb(e.toString())
      }
    })()
  }, cb)
}

// Export
module.exports = Transactions;
