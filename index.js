'use strict';
var _ = require('lodash'),
    cls = require('continuation-local-storage');

module.exports = function (Sequelize, options) {

  options = _.defaults({
    virtualFiltering: true,
    advancedCreateUpdate: false
  }, options);

  if (options.advancedCreateUpdate) {
    if (_.isUndefined(Sequelize.cls) || _.isNull(Sequelize.cls)) {
      Sequelize.cls = cls.createNamespace('sequelize-internal');
    }
  }

  function doUpsert(dataItem, association, associationModel, mainEntity) {
    if (!_.isUndefined(dataItem.Value)) {
      return associationModel.find({
        where: { Value: dataItem.Value }
      })
      .then(function (subEntity) {
        if (subEntity) {
          return mainEntity[association.associationType === 'HasMany' ? association.accessors.add : association.accessors.set].call(mainEntity, subEntity);
        } else {
          return mainEntity[association.accessors.create].call(mainEntity, dataItem, {});
        }
      });
    } else {
      if (!_.isUndefined(dataItem.isNewRecord)) {
        return mainEntity[association.associationType === 'HasMany' ? association.accessors.add : association.accessors.set].call(mainEntity, dataItem);
      } else {
        if (_.isUndefined(dataItem.id)) {
          if (_.isNumber(dataItem)) {
            return mainEntity[association.accessors.set].bind(mainEntity)(dataItem);
          } else  {
           return mainEntity[association.accessors.create].bind(mainEntity)(dataItem);
          }
        } else {
          return mainEntity[association.accessors.set].bind(mainEntity)(dataItem.id);
        }
      }
    }
  }

  function doDelete(dataItem, association, associationModel) {
    dataItem.set(association.identifierField, null);
    var stillAlive = _(associationModel.attributes)
    .filter(function (attribute) {
      return !_.isUndefined(attribute.references);
    })
    .pluck('field')
    .any(function (key) {
      return !_.isNull(dataItem[key]);
    });

    if (stillAlive) {
      return dataItem.save();
    } else {
      return dataItem.destroy();
    }
  }

  function upsertSubEntities(mainEntity, associations, data) {
    if (associations.length === 0) {
      return Sequelize.Promise.resolve(mainEntity);
    } else {
      var promises = _(associations).map(function (associationKey) {
        var associationData = data[associationKey],
            association = this.associations[associationKey],
            associationModel = association.target;

        if (_.isArray(associationData)) {
          var difference = _.filter(mainEntity[associationKey], function (item) {
            return associationData.length === 0 ? true : _.any(associationData, function (item2) {
              return item.Value !== item2.Value;
            });
          });
          return Sequelize.Promise.join(Sequelize.Promise.all(_.map(associationData, function (dataItem) {
            if (!_.isNull(dataItem)) {
              return doUpsert(dataItem, association, associationModel, mainEntity);
            }
          })), Sequelize.Promise.all(_.map(difference, function (dataItem) {
            return doDelete(dataItem, association, associationModel);
          })));
        } else if (!_.isNull(associationData) && !_.isUndefined(associationData)) {
          return doUpsert(associationData, association, associationModel, mainEntity);
        }
      }, this)  // jshint ignore:line
      .flatten()
      .value();

      return Sequelize.Promise.all(promises)
      .return(mainEntity);
    }
  }

  function sortWhere (where, includes, virtuals, operator) {
    var model = this; // jshint ignore:line
    operator = operator || 'AND';
    _.each(where, function (value, key) {
      if (_.isArray(value)) {
        var newOperator = 'AND';
        if (where instanceof Sequelize.Utils.or) {
          newOperator = 'OR';
        }
        _.each(value, function (innerWhere) {
          sortWhere.bind(model)(innerWhere, includes, virtuals, newOperator);
        });
      } else if (key.indexOf('.') >= 0) {
        delete where[key];

        var parts = key.split('.'),
            modelName = parts[0],
            propertyName = parts[1];

        if (_.isUndefined(includes[modelName])) {
          includes[modelName] = {
            as: modelName,
            model: model.associations[modelName].target,
            'AND': [],
            'OR': [],
            where: {}
          };
        }
        var obj = {};
        obj[propertyName] = value;
        includes[modelName][operator].push(obj);
      } else if (where instanceof Sequelize.Utils.where) {
        // We don't want to touch theses.
        return;
      } else {
        if (_.isUndefined(model.tableAttributes[key])) {
          delete where[key];
          virtuals[key] = value;
        }
      }
    });
  }

  Sequelize.hook('afterInit', function (sequelize) {
    sequelize.helpers = {
      transaction: function (callback) {
        var isInTransaction = !_.isUndefined(Sequelize.cls.get('transaction'));
        if (isInTransaction && sequelize.getDialect() === 'sqlite') { // SQLite doesn't support nested transactions.
          return callback();
        } else {
          return sequelize.transaction(function () {
            return callback();
          });
        }
      },
      createomatic: function (data) {
        var model = this;
        return sequelize.helpers.transaction(function () {
          return model.constructor.prototype.create.call(model, data)
          .bind(model)
          .then(function (entity) {
            var associations = this.associations;
            var associationsKeysToUpdate = _.intersection(_.keys(associations), _.keys(data));
            return upsertSubEntities.call(this, entity, associationsKeysToUpdate, data);
          })
          .then(function (entity) {
            return this.getById(entity.id);
          });
        });
      },
      updateomatic: function (id, data) {
        var model = this;
        return sequelize.helpers.transaction(function () {
          return model.getById(id)
          .bind(model)
          .then(function (entity) {
            var updatable = _.pick(data, _.keys(this.schema().tableAttributes));
            entity.set(updatable);
            var associationsKeysToUpdate = _.intersection(_.keys(this.associations), _.keys(data));
            return upsertSubEntities.call(this, entity, associationsKeysToUpdate, data);
          })
          .then(function (entity) {
            return entity.save();
          })
          .then(function (entity) {
            return this.getById(entity.id);
          });
        });
      }
    };

    if (_.isUndefined(sequelize.options.define.classMethods)) {
      sequelize.options.define.classMethods = {};
    }

    if (options.advancedCreateUpdate) {
      sequelize.options.define.classMethods.create = function () {
        if (arguments.length === 1) {
          return sequelize.helpers.createomatic.call(this, arguments[0]);
        } else {
          return this.constructor.prototype.create.apply(this, arguments);
        }
      };

      sequelize.options.define.classMethods.update = function (id, data) {
        var numId = Number(id);
        if(_.isNumber(numId)) {
          return sequelize.helpers.updateomatic.call(this, numId, data);
        } else {
          return this.constructor.prototype.update.apply(this, arguments);
        }
      };

      sequelize.options.define.classMethods.getById = function (id) {
        return this.find({
          where: { id: id },
          include: [{ all: true }]
        });
      };
    }

    sequelize.hook('beforeFind', function (options) {
      var model = this;
      if (options.where) {
        var includes = {};
        var virtuals = {};
        
        sortWhere.bind(model)(options.where, includes, virtuals);

        _.each(includes, function (include) {
          include.where = Sequelize.and(Sequelize.or.apply(null, include.OR), Sequelize.and.apply(null, include.AND));
          delete include.OR;
          delete include.AND;
        });

        if (options.include) {
          options.include = options.include.concat(_.map(includes, _.identity));
        } else {
          options.include = _.map(includes, _.identity);
        }
        options.virtuals = virtuals;
      }

      if (options.order) {
         for (var i = options.order.length -1; i >= 0 ; i--) {
          var attribute = options.order[i][0];

          if (!model.tableAttributes[attribute]) {
            if (_.isUndefined(options.virtualOrder)) {
              options.virtualOrder = [];
            }
            options.virtualOrder.push(options.order[i]);
            options.order.splice(i, 1);
          }
         }
      }
    });

    sequelize.hook('afterFind', function (instances, options) {
      function matcher (test, propertyName) {
        var propertyToTest = instance[propertyName];

        if (_.isString(test)) {
          return propertyToTest.toLowerCase() === test.toLowerCase();
        } else if (_.isNumber(test)) {
          return propertyToTest === test;
        } else if (_.isObject(test) && _.isString(test.like)) {
          // Remove the beginning and ending %.
          return _.contains(propertyToTest.toLowerCase(), test.like.toLowerCase().substring(1, test.like.length - 2));
        } else {
          throw new Error('Cannot filter on virtual property using this method.');
        }
      }
      if (options.virtuals) {
        if (_.isArray(instances)) {
          for (var i = instances.length -1; i >= 0 ; i--) {
            var instance = instances[i];
            var match = _.all(options.virtuals, matcher);

            if (!match) {
              instances.splice(i, 1);
            }
          }
        }
      }

      if (options.virtualOrder && _.isArray(instances)) {
        var newInstances = instances.splice(0, instances.length);
        _(newInstances)
        .sortByOrder(
          _.map(options.virtualOrder, _.first),
          _.map(options.virtualOrder,
            function (dir) {
              return _.last(dir) === 'ASC';
            })
        )
        .each(function (item) {
          instances.push(item);
        })
        .value();
      }
    });
  });
};