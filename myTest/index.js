const fs = require('fs');
const zlib = require('zlib');
const { Writable, Stream, Readable } = require('stream');
const r = fs.createReadStream(__dirname + '/1.txt');
const z = zlib.createGzip();
const w = fs.createWriteStream(__dirname + '/file.txt.gz');
// Stream.prototype.pipe = function () {};
// Writable.prototype.pipe = function () {};
// Readable.prototype.pipe = function () {}
// console.log(Object.getPrototypeOf(z).pipe(w));
// console.log(Object.getPrototypeOf(r.pipe(z)).pipe(w))
let v = r.pipe(z);
const s = v.pipe(w);
// s.pipe(); --记录这个玩意儿，其次整理调试信息怎么看，原型啥的
console.log(Object.getPrototypeOf(Readable.prototype) === Stream.prototype);
console.log(Object.getPrototypeOf(Stream) === Stream.prototype);
const y = new Readable();
const q = Readable.prototype;
console.log(q instanceof Stream);
const m = Stream.prototype;
const t = Object.getPrototypeOf(y);

// console.log(new Writable().pipe())
// console.log(r.pipe(z).pipe())
console.log('sss');
