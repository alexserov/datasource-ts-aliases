import { parse, print } from 'recast';
import { visit, namedTypes, builders } from 'ast-types';
import { readFile, writeFile } from 'fs';
import { dirname, basename, extname, resolve, relative } from 'path';
import glob from 'glob';
import { promisify } from 'util';
import tsparser from 'recast/parsers/typescript.js'

const path = process.argv[2];
const aliasesModule = process.argv[3];

class BaseMixinDataSource {
    // BaseMixinDataSource: Store | DataSource | DataSourceOptions
    requiredFields = ['Store', 'DataSource', 'DataSourceOptions'];
    name = 'BaseMixinDataSource';
    fillTypesMap(node) {
        const result = {
            known: {},
            unknown: []
        }
        if (!node.types) return result;
        node.types.forEach(t => {
            if (namedTypes.TSTypeReference.check(t)) {
                const name = t.typeName.name;
                const field = { key: name, value: t };
                if (this.requiredFields.includes(field.key)) {
                    result.known[name] = field.value;
                } else {
                    result.unknown.push(field);
                }
            }
        });
        return result;
    }
    check(node) {
        if (!namedTypes.TSUnionType.check(node))
            return false;
        const map = this.fillTypesMap(node);
        const count = this.requiredFields.map(x => map.known[x]).reduce((prev, curr) => prev += +!!curr, 0);
        if (count === this.requiredFields.length) return this;
    }
    getBaseNode(map) {
        return builders.tsTypeReference(builders.identifier(this.name));
    }
    from(node) {
        const map = this.fillTypesMap(node);
        const base = this.getBaseNode(map);
        if (map.unknown.length) {
            return builders.tsUnionType([base, ...map.unknown]);
        }
        return base;
    }
};
class DataSourceMixinArray extends BaseMixinDataSource {
    // DataSourceMixinArray: Array<any> | Store | DataSourceOptions
    name = 'DataSourceMixinArray';
    constructor() {
        super();
        this.requiredFields = ['Array', 'Store', 'DataSourceOptions']
    }
    getBaseNode(map) {
        return builders.tsTypeReference(builders.identifier(this.name), map.known['Array'].typeParameters);
    }
};
class DataSourceMixinString extends BaseMixinDataSource {
    // DataSourceMixinString: string | BaseMixinDataSource
    name = 'DataSourceMixinString';
    constructor() {
        super();
        this.requiredFields = ['string', ...this.requiredFields]
    }
    getBaseNode(map) {
        return builders.tsTypeReference(builders.identifier(this.name));
    }
};
class ComplexCollectionDataSource extends DataSourceMixinString {
    // ComplexCollectionDataSource<T>:  Array<string | T | any> | DataSourceMixinString
    name = 'ComplexCollectionDataSource';
    constructor() {
        super();
        this.requiredFields = ['Array', 'Store', 'DataSource', 'DataSourceOptions']
    }
    getBaseNode(map) {
        return builders.tsTypeReference(builders.identifier(this.name), map.known['Array'].typeParameters);
    }
    from(node) {
        const map = this.fillTypesMap(node);
        const base = this.getBaseNode(map);
        if (map.unknown.length) {
            debugger;
        }
        map.unknown = map.unknown.filter(x => x.key !== 'string');
        if (map.unknown.length) {
            return builders.tsUnionType([base, ...map.unknown]);
        }
        return base;
    }
};

const customTypes = {
    ComplexCollectionDataSource: new ComplexCollectionDataSource(),
    DataSourceMixinString: new DataSourceMixinString(),
    DataSourceMixinArray: new DataSourceMixinArray(),
    BaseMixinDataSource: new BaseMixinDataSource()
}

glob(path, async (err, filePathes) => {
    let processed = filePathes.length;
    await Promise.all(filePathes.map(async (filePath) => {
        if (resolve(filePath) === resolve(aliasesModule))
            return;
        const fileString = (await promisify(readFile)(filePath)).toString();

        const ast = parse(fileString, {
            parser: tsparser,
            sourceFileName: filePath
        });

        const targets = [];
        
        visit(ast, {
            visitTSTypeReference(path) {
                const name = path.node.typeName.name;
                if (name !== 'Store' && name !== 'DataSource') {
                    this.traverse(path);
                    return;
                }
                let targetPath = path;
                while (targetPath!=null) {
                    const parentPath = targetPath.parent;
                    if (!namedTypes.TSType.check(parentPath.node))
                        break;
                    targetPath = parentPath;
                }
                targets.push(targetPath);
                this.traverse(path);
            },
        });

        const unknownTargets = [];
        const newAPI = {};
        targets.forEach(x => {
            const target = customTypes.ComplexCollectionDataSource.check(x.node)
                || customTypes.DataSourceMixinString.check(x.node)
                || customTypes.DataSourceMixinArray.check(x.node)
                || customTypes.BaseMixinDataSource.check(x.node);
            if (target) {
                x.replace(target.from(x.node));
                newAPI[target.name] = true;
            } else {
                unknownTargets.push(x);
            }
        });

        
        importAlias(filePath, ast, newAPI);
        removeUnusedAliases(ast);

        const result = print(ast, { quote: 'single', lineTerminator: '\n' });
        const ext = extname(filePath);
        const base = basename(filePath).slice(0, -ext.length);

        if (Object.keys(newAPI).length)
            await promisify(writeFile)(filePath, result.code);
        processed--;
        console.log(`Remaining: ${processed}`);
    }));
});
function removeUnusedAliases(ast) {
    const usedNames = {};
    visit(ast, {
        visitImportDeclaration(path) {
            return false;
        },
        visitIdentifier(path) {
            const name = path.node.name;
            usedNames[name] = true;
            this.traverse(path);
        }
    });
    visit(ast, {
        visitImportDefaultSpecifier(path) {
            if (!usedNames[path.node.local.name]) {
                path.prune();
                return false;
            }
            this.traverse(path);
        },
        visitImportSpecifier(path) {
            if (!usedNames[path.node.imported.name]) {
                path.prune();
                return false;
            }
            this.traverse(path);
        }
    });
    visit(ast, {

        visitImportDeclaration(path) {
            if (path.node.specifiers && !path.node.specifiers.length) {
                path.prune();
                return false;
            }
            this.traverse(path);
        },
    });
}
function importAlias(filePath, ast, newAPI) {
    const newapiKeys = Object.keys(newAPI);
    if (newapiKeys.length) {
        let relativePathToAliasesModule = relative(dirname(filePath), aliasesModule).replace(/\\/g, '/');
        if (relativePathToAliasesModule[0] != '.')
            relativePathToAliasesModule = './' + relativePathToAliasesModule;
        relativePathToAliasesModule = relativePathToAliasesModule.slice(0, -5);
        let shouldAdd = true;
        visit(ast, {
            visitImportDeclaration(path) {
                if (path.node.source.extra.raw.slice(1, -1) === relativePathToAliasesModule) {

                    const currentSpecifiers = path.node.specifiers.map(x => {
                        if (namedTypes.ImportDefaultSpecifier.check(x))
                            return '';
                        return x.imported.name;
                    });
                    const specifiersToAdd = newapiKeys.filter(x => !currentSpecifiers.includes(x));
                    path.replace(builders.importDeclaration(
                        [...path.node.specifiers, ...specifiersToAdd.map(x => builders.importSpecifier(builders.identifier(x)))],
                        path.node.source
                    ));
                    shouldAdd = false;
                }
                this.traverse(path);
            },
        });
        if (shouldAdd) {
            ast.program.body.unshift(builders.importDeclaration(
                [...newapiKeys.map(x => builders.importSpecifier(builders.identifier(x)))],
                builders.stringLiteral(relativePathToAliasesModule)
            ));
        }
    }
}

