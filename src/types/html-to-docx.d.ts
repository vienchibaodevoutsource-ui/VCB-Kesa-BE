declare module 'html-to-docx' {
  export default function HTMLtoDOCX(
    htmlString: string,
    headerHTMLString?: string,
    documentOptions?: Record<string, unknown>,
    footerHTMLString?: string,
  ): Promise<Buffer | ArrayBuffer>;
}
