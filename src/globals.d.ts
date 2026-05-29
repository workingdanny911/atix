// Bun text imports (`import x from "./file.sql" with { type: "text" }`) resolve
// to the file contents as a string. TS has no built-in declaration for `.sql`,
// so we declare it here.
declare module "*.sql" {
  const content: string;
  export default content;
}
