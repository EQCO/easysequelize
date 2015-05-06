'use strict';
var _ = require('lodash');
module.exports = function (Sequelize) {

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