// Generatore PDF dei preventivi Ottantunocento — stesso layout del modello dell'app Preventivi
// (carta intestata con loghi, barre colorate, tabella arancione, piè di pagina scuro), ma vettoriale e leggero.
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage, PDFImage } from "npm:pdf-lib@1.17.1";

export const AZIENDA = {
  nome: "OTTANTUNOCENTO S.R.L.",
  footerSx1: "Via Gemito 95 · 81100 Caserta (CE)",
  footerSx2: "P.IVA e C.F. 02187720616 · REA CE-145343 · Cap. soc. €20.000,00 i.v. · SDI W7YVJK9",
  footerDx: ["T 0823 353336", "ottantunocentogroup@gmail.com", "PEC 81100@open.legalmail.it"],
  firmatario: "De Candiziis Ivo",
  carica: "Amministratore Unico",
  citta: "Caserta",
};

const hexRgb = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const C = {
  giallo: hexRgb("#ffae1e"), rosa: hexRgb("#fe5c83"), azzurro: hexRgb("#00b2ec"), arancio: hexRgb("#e8891b"),
  scuro: hexRgb("#1d1c1a"), testo: hexRgb("#1d1c1a"), grigio: hexRgb("#6b6b6b"), grigioChiaro: hexRgb("#e6e6e6"),
  bianco: rgb(1, 1, 1),
};
const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

// Helvetica standard usa WinAnsi: sostituisce i caratteri non rappresentabili
function safe(s: any): string {
  return String(s ?? "")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/—/g, "-").replace(/→/g, "->").replace(/ /g, " ")
    .replace(/[^\x20-\x7E -ÿ€–…]/g, "");
}
const eur = (n: number) =>
  "€" + (Number(n) || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function dataLunga(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${parseInt(m[3])} ${MESI[parseInt(m[2]) - 1]} ${m[1]}` : safe(iso);
}
function wrap(text: string, font: PDFFont, size: number, max: number): string[] {
  const out: string[] = [];
  for (const par of safe(text).split(/\n/)) {
    let line = "";
    for (const w of par.split(/\s+/)) {
      if (!w) continue;
      const t = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(t, size) <= max) line = t;
      else { if (line) out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

const W = 595.28, H = 841.89;
const SX = 56, DX = 545;            // margini del corpo (come il modello)
const LIMITE = 735;                  // ultima riga utile prima del piè di pagina (distanza dall'alto)

// loghi: PNG in base64 (carta intestata), letti da agente_config (pdf_logo_81100, pdf_logo_dx)
export async function preventivoPdf(p: any, loghi: { sx: string; dx: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Preventivo ${p.numero}`);
  doc.setAuthor(AZIENDA.nome);
  doc.setProducer("Gestionale 81|00");
  const F = await doc.embedFont(StandardFonts.Helvetica);
  const B = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo: PDFImage = await doc.embedPng(Uint8Array.from(atob(loghi.sx), (c) => c.charCodeAt(0)));
  const loghiDx: PDFImage = await doc.embedPng(Uint8Array.from(atob(loghi.dx), (c) => c.charCodeAt(0)));

  let page!: PDFPage;
  let y = 0; // distanza dall'alto

  // ---- primitive in coordinate "dall'alto" ----
  const T = (t: string, x: number, top: number, size: number, font = F, color = C.testo) =>
    page.drawText(safe(t), { x, y: H - top, size, font, color });
  const TR = (t: string, xr: number, top: number, size: number, font = F, color = C.testo) => {
    const s = safe(t); page.drawText(s, { x: xr - font.widthOfTextAtSize(s, size), y: H - top, size, font, color });
  };
  const largSp = (t: string, size: number, font: PDFFont, sp: number) =>
    [...safe(t)].reduce((w, ch) => w + font.widthOfTextAtSize(ch, size) + sp, 0) - sp;
  const TS = (t: string, x: number, top: number, size: number, font: PDFFont, color: any, sp: number) => {
    let cx = x;
    for (const ch of safe(t)) { page.drawText(ch, { x: cx, y: H - top, size, font, color }); cx += font.widthOfTextAtSize(ch, size) + sp; }
  };
  const R = (x: number, top: number, w: number, h: number, color: any, opacity = 1) =>
    page.drawRectangle({ x, y: H - top - h, width: w, height: h, color, opacity });
  const L = (x1: number, x2: number, top: number, th: number, color: any) =>
    page.drawLine({ start: { x: x1, y: H - top }, end: { x: x2, y: H - top }, thickness: th, color });

  // ---- carta intestata ----
  const intestazione = (prima: boolean) => {
    // sfondo acquerello leggerissimo (come il modello)
    page.drawCircle({ x: 470, y: H - 470, size: 235, color: C.giallo, opacity: 0.03 });
    page.drawCircle({ x: 430, y: H - 520, size: 170, color: C.rosa, opacity: 0.02 });
    page.drawCircle({ x: 560, y: H - 500, size: 105, color: C.azzurro, opacity: 0.03 });
    // barre colorate in alto a destra
    R(374, 0, W - 374, 25.2, C.giallo);
    R(436, 25.2, W - 436, 6, C.rosa);
    R(487.5, 31.2, W - 487.5, 3.8, C.azzurro);
    // loghi e riga servizi
    let rigaTop: number;
    if (prima) {
      page.drawImage(logo, { x: 54.5, y: H - 54.5 - 58.9, width: 118, height: 58.9 });
      page.drawImage(loghiDx, { x: 386, y: H - 63 - 37.5, width: 159.3, height: 37.5 });
      rigaTop = 132.5;
    } else {
      page.drawImage(logo, { x: 54.5, y: H - 54 - 41.5, width: 83.3, height: 41.5 });
      rigaTop = 115.5;
    }
    page.drawSvgPath("M 3 0 L 41 0 L 38 3 L 0 3 Z", { x: SX, y: H - rigaTop + 1.5, color: C.arancio });
    L(105, 329.5, rigaTop, 0.6, C.scuro);
    { const sv = "EVENTI · SERVICE · STRUTTURE · TICKETING"; TS(sv, DX - largSp(sv, 7.2, B, 1.1), rigaTop + 3, 7.2, B, hexRgb("#555555"), 1.1); }
    return rigaTop;
  };
  const piede = () => {
    R(0, 761, W, 77.5, C.scuro);
    R(0, 838.5, 297.3, H - 838.5, C.giallo);
    R(297.3, 838.5, 198.7, H - 838.5, C.rosa);
    R(496, 838.5, W - 496, H - 838.5, C.azzurro);
    const nome = AZIENDA.nome;
    TS(nome, SX, 808.5, 7.6, B, C.bianco, 0.6);
    T(" · " + AZIENDA.footerSx1, SX + largSp(nome, 7.6, B, 0.6), 808.5, 7.4, F, C.bianco);
    T(AZIENDA.footerSx2, SX, 819.5, 7.4, F, C.bianco);
    AZIENDA.footerDx.forEach((r, i) => TR(r, 543.5, 784 + i * 11, 7.4, F, C.bianco));
  };
  const nuovaPagina = (prima: boolean) => {
    page = doc.addPage([W, H]);
    const r = intestazione(prima);
    piede();
    y = r + 34;
  };
  const spazio = (h: number) => { if (y + h > LIMITE) nuovaPagina(false); };

  // ================= PAGINA 1 =================
  nuovaPagina(true);

  // numero e data
  TS(`PREVENTIVO ${p.numero}`, SX, 171, 6.8, B, C.arancio, 1.2);
  T(`${AZIENDA.citta}, ${dataLunga(p.data)}`, SX, 184, 9.2, F, hexRgb("#444444"));

  // destinatario
  const xD = 339.5, wD = DX - xD;
  L(xD, DX, 163, 1, C.scuro);
  TS("SPETT.LE", xD, 184, 6.2, F, C.grigio, 1);
  let yd = 202;
  for (const l of wrap(p.cliente_nome || "", B, 10, wD)) { T(l, xD, yd, 10, B); yd += 15.75; }
  if (p.cliente_riferimento) { T(`Alla c.a. ${p.cliente_riferimento}`, xD, yd, 10); yd += 15.75; }
  for (const parte of String(p.cliente_indirizzo || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    for (const l of wrap(parte, F, 10, wD)) { T(l, xD, yd, 10); yd += 15.75; }
  }
  if (p.cliente_piva) { T(`P.IVA ${p.cliente_piva}`, xD, yd, 9.5, F, C.grigio); yd += 15.75; }
  y = Math.max(yd + 30, 352);

  // oggetto
  TS("OGGETTO", SX + 1, y, 6.6, B, C.arancio, 1.2);
  for (const l of wrap(p.oggetto || "", B, 12.5, DX - 112)) { spazio(16); T(l, 112, y, 12.5, B); y += 16.5; }
  if (p.rif_richiesta) { y += 2; for (const l of wrap(`Rif. richiesta: ${p.rif_richiesta}`, F, 9, DX - 112)) { T(l, 112, y, 9, F, C.grigio); y += 13; } }
  y += 22;

  // introduzione
  if (p.intro) { for (const l of wrap(p.intro, F, 10, DX - SX)) { spazio(15); T(l, SX, y, 10); y += 15.5; } y += 14; }

  // tabella
  const corpo = p.modalita === "corpo";
  const righe = Array.isArray(p.righe) ? p.righe : [];
  const wDesc = corpo ? DX - SX - 20 : 300 - SX;
  const intestTabella = () => {
    spazio(60);
    R(SX, y, DX - SX, 25.5, C.arancio);
    TS("DESCRIZIONE", 65, y + 16, 6.6, B, C.bianco, 1.1);
    if (!corpo) {
      TS("Q.TÀ", 360, y + 16, 6.6, B, C.bianco, 1.1);
      const pz = "PREZZO"; TS(pz, 456 - largSp(pz, 6.6, B, 1.1), y + 16, 6.6, B, C.bianco, 1.1);
      const im = "IMPORTO"; TS(im, 536 - largSp(im, 6.6, B, 1.1), y + 16, 6.6, B, C.bianco, 1.1);
    }
    y += 25.5 + 19;
  };
  intestTabella();
  for (const r of righe) {
    const qta = Number(r.qta ?? 1) || 0, prezzo = Number(r.prezzo) || 0;
    const ls = wrap(r.descrizione || "", F, 9.5, wDesc);
    const h = ls.length * 15.3 + 14;
    if (y + h > LIMITE) { nuovaPagina(false); intestTabella(); }
    const y0 = y;
    for (const l of ls) { T(l, 65, y, 9.5); y += 15.3; }
    if (!corpo) {
      T(String(qta).replace(".", ","), 366, y0, 9.5);
      TR(eur(prezzo), 456, y0, 9.5);
      TR(eur(qta * prezzo), 536, y0, 9.5);
    }
    y += 2;
    L(SX, DX, y, 0.5, C.grigioChiaro);
    y += 19;
  }

  // totali
  const ivaTipo = p.iva_tipo || "normale";
  const voci: [string, number][] = [["Imponibile", Number(p.imponibile) || 0]];
  if (ivaTipo === "art7quater") voci.push(["IVA (art. 7-quater)", 0]);
  else voci.push([`IVA ${p.iva_perc ?? 22}%${ivaTipo === "split" ? " (split payment)" : ""}`, Number(p.iva_importo) || 0]);
  // altezza del blocco finale (totali, validità, note, firma): se non entra va tutto a pagina nuova, come il modello
  const hVal = p.validita ? 30 + 21 * (wrap(p.validita, F, 12.5, DX - SX - B.widthOfTextAtSize("Validità dell'offerta: ", 12.5)).length - 1) : 0;
  const hNote = p.note_finali ? 22 * wrap(p.note_finali, F, 12.5, DX - SX - 30).length : 0;
  const hIva = ivaTipo === "normale" ? 0 : 36;
  const hBlocco = 6 + voci.length * 23 + 40 + hIva + 10 + hVal + hNote + 26 + 58;
  if (y + hBlocco > LIMITE && hBlocco < LIMITE - 150) nuovaPagina(false);
  else spazio(80);
  y += 6;
  for (const [lab, val] of voci) { T(lab, 338, y, 9.3, F, hexRgb("#444444")); TR(eur(val), 536, y, 9.3, F, hexRgb("#444444")); y += 23; }
  R(330, y - 14, DX - 330, 27, C.scuro);
  const labTot = ivaTipo === "split" ? "Totale documento" : (ivaTipo === "art7quater" ? "Totale" : "Totale IVA inclusa");
  T(labTot, 343, y + 3.5, 10, B, C.bianco);
  TR(eur(Number(p.totale) || 0), 536, y + 3.5, 10.5, B, C.bianco);
  y += 40;
  if (ivaTipo === "split") { for (const l of wrap("Operazione soggetta a scissione dei pagamenti (art. 17-ter DPR 633/72): l'IVA è versata dall'ente committente.", F, 8.5, DX - SX)) { spazio(12); T(l, SX, y, 8.5, F, C.grigio); y += 12; } y += 8; }
  if (ivaTipo === "art7quater") { for (const l of wrap("Operazione non soggetta a IVA ai sensi dell'art. 7-quater DPR 633/72.", F, 8.5, DX - SX)) { spazio(12); T(l, SX, y, 8.5, F, C.grigio); y += 12; } y += 8; }

  // validità e note
  y += 10;
  if (p.validita) {
    const lab = "Validità dell'offerta: ";
    const wl = B.widthOfTextAtSize(safe(lab), 12.5);
    const ls = wrap(p.validita, F, 12.5, DX - SX - wl);
    spazio(22);
    T(lab, SX, y, 12.5, B);
    ls.forEach((l, i) => { if (i) { y += 21; spazio(21); } T(l, i ? SX : SX + wl, y, 12.5); });
    y += 30;
  }
  if (p.note_finali) { for (const l of wrap(p.note_finali, F, 12.5, DX - SX - 30)) { spazio(22); T(l, SX, y, 12.5); y += 22; } }

  // firma
  y += 26;
  spazio(70);
  TS(AZIENDA.nome, 340, y, 6.8, B, C.testo, 1.1);
  y += 29;
  L(340, DX, y, 0.6, hexRgb("#bdbdbd"));
  y += 15;
  T(AZIENDA.firmatario, 340, y, 9.5, B);
  y += 14;
  T(AZIENDA.carica, 340, y, 8.5, F, C.grigio);

  // numerazione pagine nel piè di pagina
  const pagine = doc.getPages();
  pagine.forEach((pg, i) => {
    const t = `Pag ${i + 1} di ${pagine.length}`;
    pg.drawText(t, { x: 543.5 - B.widthOfTextAtSize(t, 7.6), y: H - 819.5, size: 7.6, font: B, color: C.bianco });
  });
  return await doc.save();
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
