
const books=new Map(),pages=new Map(),texts=new Map(),files=new Map();
export const newId=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
export async function putBook(b){books.set(b.id,b)}
export async function getBook(id){return books.get(id)}
export async function listBooks(){return [...books.values()].sort((a,b)=>b.updatedAt-a.updatedAt)}
export async function patchBook(id,patch){const b=books.get(id);if(b)Object.assign(b,patch);return b}
export async function putPage(rec){pages.set(rec.bookId+':'+rec.n,rec)}
export async function getPage(id,n){return pages.get(id+':'+n)}
export async function getPages(id){return [...pages.values()].filter(p=>p.bookId===id).sort((a,b)=>a.n-b.n)}
export async function putTexts(id,x){texts.set(id,x)}
export async function getTexts(id){return texts.get(id)||[]}
export async function putFile(id,blob,name){files.set(id,{blob,name})}
export async function getFile(id){return files.get(id)}
export async function deleteBook(id){books.delete(id);texts.delete(id);files.delete(id);for(const k of [...pages.keys()])if(k.startsWith(id+':'))pages.delete(k)}
