import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../src/eda');
function sources(directory:string):string[]{
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.name==='generated'?[]:
    entry.isDirectory()?sources(resolve(directory,entry.name)):entry.name.endsWith('.ts')?[resolve(directory,entry.name)]:[]);
}

test('EDA feature layout has explicit business owners without old Core or Integrations forwarding folders',()=>{
  const actual=readdirSync(resolve(root,'modules'),{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort();
  assert.deepEqual(actual,['appointment','composition','intelligence','messaging','payment','platform-delivery','portal-integrations','profile','records','video']);
  for(const old of ['core','integrations'])assert.equal(existsSync(resolve(root,'../../dist/modules',old)),false,'Build must remove retired compiled module paths.');
  const manifest=JSON.parse(readFileSync(resolve(root,'../../package.json'),'utf8'));
  assert.match(manifest.scripts.build,/node scripts\/eda\/clean-output\.mjs/);
  assert.match(readFileSync(resolve(root,'../../Dockerfile'),'utf8'),/COPY scripts\/eda\/clean-output\.mjs \.\/scripts\/eda\/clean-output\.mjs/);
  for(const path of sources(resolve(root,'modules/composition'))){
    assert.doesNotMatch(readFileSync(path,'utf8'),/\.query\s*\(|\$queryRaw|\$executeRaw/,'Composition must delegate SQL to its owning features.');
  }
});

test('EDA relative module imports resolve with exact Linux casing and NodeNext runtime extensions',()=>{
  for(const path of sources(root)){
    const text=readFileSync(path,'utf8'),source=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
    function visit(node:ts.Node){
      const literal=(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)?node.moduleSpecifier:null;
      if(literal?.text.startsWith('.')){
        assert.match(literal.text,/\.js$/,relative(root,path)+': runtime import must retain .js');
        const target=resolve(dirname(path),literal.text).replace(/\.js$/,'.ts');
        assert.ok(existsSync(target),relative(root,path)+': missing '+literal.text);
        let current=target;
        while(current!==root&&current.startsWith(root+sep)){
          assert.ok(readdirSync(dirname(current)).includes(basename(current)),relative(root,path)+': Linux case mismatch '+literal.text);
          current=dirname(current);
        }
        assert.doesNotMatch(literal.text,/modules\/(?:core|integrations)\//);
      }
      ts.forEachChild(node,visit);
    }
    visit(source);
  }
});
