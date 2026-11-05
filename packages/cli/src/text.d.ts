// Files imported with ?text are inlined as strings by tsup (see tsup.config.ts).
declare module '*?text' {
  const text: string;
  export default text;
}
