export class TextCleaner {
  clean(text: string): string {
    return (
      text
        // Remove extra whitespace
        .replace(/\s+/g, ' ')
        // Remove excessive line breaks
        .replace(/\n\s*\n\s*\n/g, '\n\n')
        // Remove common web elements noise
        .replace(/Cookie\s*banner|privacy\s*policy|terms\s*of\s*use/gi, '')
        // Remove menu/navigation indicators
        .replace(/menu|navigation|nav|header|footer/gi, '')
        // Remove ads indicators
        .replace(/advertisement|ads|sponsored/gi, '')
        // Remove social media indicators
        .replace(/share|tweet|facebook|twitter|instagram/gi, '')
        // Clean up punctuation around line breaks
        .replace(/\n[.,!?;:]/g, '')
        // Remove empty lines with only spaces
        .replace(/^\s*\n/gm, '')
        // Trim start and end
        .trim()
    );
  }

  removeNoise(text: string): string {
    // More aggressive cleaning for web scraping
    return this.removeHTMLTags(
      this.removeJavaScript(
        this.removeCSS(
          this.removeNavigationElements(
            this.removeFooterElements(
              this.removeSidebarElements(this.removeAdvertisements(text)),
            ),
          ),
        ),
      ),
    ).trim();
  }

  private removeHTMLTags(text: string): string {
    return text.replace(/<[^>]*>/g, ' ');
  }

  private removeJavaScript(text: string): string {
    return text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  }

  private removeCSS(text: string): string {
    return text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  }

  private removeNavigationElements(text: string): string {
    return text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  }

  private removeFooterElements(text: string): string {
    return text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  }

  private removeSidebarElements(text: string): string {
    return text.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');
  }

  private removeAdvertisements(text: string): string {
    return text.replace(
      /class="[^"]*ad[^"]*"|class="[^"]*ads[^"]*"|class="[^"]*advertisement[^"]*"/gi,
      '',
    );
  }
}
