// Images imported by the shell are bundled by Vite and resolve to their URL.
declare module "*.jpg" {
  const url: string;
  export default url;
}
