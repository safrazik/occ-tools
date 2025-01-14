'use strict';

var fs = require('fs-extra');
var walk = require('walkdir');
var path = require('path');
var UglifyJS = require('uglify-js');
var webpack = require('webpack');
var winston = require('winston');
var occConfigs = require('../config');
var util = require('util');

/**
 * Create the index file containing the app level
 * dependencies
 * @param  {Array} filesList each file
 * @return {String}           the index file content
 */
function createJsBundleIndexFile(filesList) {
  var appLevelIndexTemplate = fs.readFileSync(path.join(__dirname, '..', 'extension', 'templates', 'app-level-index.js'), 'utf-8');

  var dependenciesImports = [];
  var allDependencies = [];
  var dependenciesApp = [];

  filesList.forEach(function (fileObject) {
    var fileName = fileObject.fileName;

    dependenciesImports.push('import ' + fileName + ' from \'' + fileObject.path + '\';');
    allDependencies.push(fileName);
    dependenciesApp.push('app[\'' + fileName + '\'] = ' + fileName + ';');
  });

  dependenciesImports = dependenciesImports.join('\n');
  allDependencies = allDependencies.join(',');
  dependenciesApp = dependenciesApp.join('\n');

  appLevelIndexTemplate = appLevelIndexTemplate.replace(/#dependenciesImports/g, dependenciesImports);
  appLevelIndexTemplate = appLevelIndexTemplate.replace(/#allDependencies/g, allDependencies);
  appLevelIndexTemplate = appLevelIndexTemplate.replace(/#dependenciesApp/g, dependenciesApp);

  return appLevelIndexTemplate;
}

/**
 * Bundle all JS from an app level extension
 * @param  {Array}   options Generate options
 * @param  {Function} done   on done the process
 */
function jsBundle(options, done) {
  var occToolsModulesPath = path.join(occConfigs.occToolsPath, '..', 'node_modules');

  var plugins = [];
  plugins.push(new webpack.dependencies.LabeledModulesPlugin());
  plugins.push(new webpack.optimize.UglifyJsPlugin({
    compress: {
      warnings: false
    },
    output: {
      comments: false
    }
  }));

  var entryFile = path.join(options.dir, options.name, 'index.js');
  var outputFile = path.join(path.dirname(entryFile), options.name + '.js');
  var webpackConfigs = {
    resolveLoader: {
      root: [
        occToolsModulesPath
      ]
    },
    entry: entryFile,
    output: {
      path: path.dirname(entryFile),
      filename: options.name + '.js',
      libraryTarget: 'amd'
    },
    externals: [
      /^((\/file)|(\/oe-files)|(?!\.{1}|occ-components|(.+:\\)|\/{1}[a-z-A-Z0-9_.]{1})).+?$/
    ],
    module: {
      loaders: [{
        test: /\.js$/,
        loader: 'babel-loader',
        include: [
          path.join(options.dir, options.name)
        ],
        query: {
          presets: [path.join(occToolsModulesPath, 'babel-preset-es2015')],
          plugins: [
            path.join(occToolsModulesPath, 'babel-plugin-transform-decorators-legacy'),
            path.join(occToolsModulesPath, 'babel-plugin-transform-class-properties')
          ],
          cacheDirectory: true
        }
      }]
    },
    plugins: plugins
  };

  var bundler = webpack(webpackConfigs);

  bundler.run(function (error, stats) {
    winston.info('[bundler:compile] %s', stats.toString({
      chunks: true, // Makes the build much quieter
      colors: true
    }));

    if (error) {
      done(error, null);
      return;
    }

    done(null, outputFile, options.name + '.js', outputFile, entryFile, stats);
  });
}

/**
 * Remove all files generated on the process of bundling
 *
 * @param  {String}   outputFilePath file generated by webpack
 * @param  {String}   entryFilePath  file generated by createJsBundleIndexFile
 * @param  {Function} done           on finishing the delete process
 */
function clearJsBundleFiles(outputFilePath, entryFilePath, done) {
  try {
    fs.unlinkSync(outputFilePath);
    fs.unlinkSync(entryFilePath);

    if (/oeLibs/.test(entryFilePath)) {
      walk(path.join(path.dirname(entryFilePath), 'vendors')).on('file', function (item) {
        if (/\.min\.js/.test(item)) {
          fs.unlinkSync(item);
        }
      }).on('end', function () {
        done(null, 'success');
      });
    } else {
      done(null, 'success');
    }
  } catch (error) {
    done(error, null);
  }
}


function bundleAppLevelJS(options, callback) {
  var filesList = [];
  var currentAppLevelExtensionDir = path.join(options.dir, options.name);
  var transpiledAppLevelDir = path.join(occConfigs.dir.project_root, '.occ-transpiled', 'app-level', options.name);
  var configs = {};
  var configsPath = path.resolve(options.dir, options.name, 'configs.json');

  if (fs.existsSync(configsPath)) {
    var contents = fs.readFileSync(configsPath, 'utf8');

    try {
      contents = JSON.parse(contents);

      if (contents.uglify) {
        configs = Object.assign({}, configs, contents);
      }
    } catch(err) {
      callback(util.format('Error parsing appLevel configuration file. Please check %s configuration\'s integrity.', options.name));
    }
  }

  walk(currentAppLevelExtensionDir).on('file', function (item) {

    if (new RegExp(configsPath).test(item)) return;

    if (/\.js/.test(item)) {
      var jsName = path.basename(item, '.js');

      if (/vendors/.test(item) && !/\.min\.js/.test(item) && configs.uglify !== false) {
        var minifiedFile = UglifyJS.minify(item, configs.uglify);
        var tempFileDir = path.join(transpiledAppLevelDir, 'vendors');

        item = item.resolve(tempFileDir, jsName + '.min.js');

        fs.ensureDirSync(tempFileDir);
        fs.writeFileSync(item, minifiedFile.code);
      }

      jsName = jsName.replace(/[^\w\s]/g, '');

      filesList.push({
        fileName: jsName,
        path: item.replace(/\\/g, '\\\\') // Making sure the app level generator will work fine with windows
      });
    }
  }).on('end', function () {
    var appLevelIndexTemplate = createJsBundleIndexFile(filesList);

    fs.writeFile(path.join(currentAppLevelExtensionDir, 'index.js'), appLevelIndexTemplate, { encoding: 'utf8' }, function (error) {
      if (error) {
        callback(error);
        return;
      }

      jsBundle(options, callback);
    });
  });
}


/**
 * Get application and extension information
 *
 * @param {string} extensionName The extension name
 * @param {request} occ The OCC requester
 * @param {function} callback The callback function,
 * will return application and extension as parameter
 */
module.exports = {
  bundle: function (options, callback) {
    bundleAppLevelJS(options, callback);
  },
  clear: clearJsBundleFiles
};
