# Next.js + shadcn/ui Template

A modern, feature-rich template with **Next.js 16**, **shadcn/ui (Base UI)**, **Zustand**, **next-themes**, and **next-intl** internationalization. Perfect for kickstarting your next project with powerful built-in features.

Built by **[LIKEDREAMWALKER](https://github.com/LikeDreamwalker)** with love ❤️

## 🚀 Live Demo

Check out the live demo: [nextjs-shadcn-template-alpha.vercel.app](https://nextjs-shadcn-template-alpha.vercel.app)

## ✨ Features

- 🎯 **[Next.js 16](https://nextjs.org)** - Latest React framework with App Router & Turbopack
- 🎨 **[shadcn/ui](https://ui.shadcn.com)** - Beautiful and accessible UI components (Base UI)
- 📦 **[Zustand](https://zustand-demo.pmnd.rs)** - Simple and scalable state management
- 🌙 **[next-themes](https://github.com/pacocoursey/next-themes)** - Perfect dark mode support
- 🌍 **[next-intl](https://next-intl-docs.vercel.app)** - Complete internationalization (English & Chinese)
- 💼 **TypeScript** - Full type safety out of the box
- 🎨 **[Tailwind CSS](https://tailwindcss.com)** - Utility-first CSS framework
- 📱 **Responsive Design** - Mobile-first approach
- ⚡ **Turbopack** - Ultra-fast development server

## 🛠️ Tech Stack

| Technology   | Purpose              | Version |
| ------------ | -------------------- | ------- |
| Next.js      | React Framework      | 16.2.3  |
| shadcn/ui    | UI Component Library | Latest (Base UI) |
| Zustand      | State Management     | 5.0.12   |
| next-themes  | Theme Management     | 0.4.6   |
| next-intl    | Internationalization | 4.9.0   |
| TypeScript   | Type Safety          | 6.x     |
| Tailwind CSS | Styling              | 4.x     |

## 🚦 Getting Started

### Prerequisites

- Node.js 20.9 or later
- pnpm (recommended) or npm/yarn

### Installation

1. **Clone this repository**

   ```bash
   git clone https://github.com/ldw-templates/nextjs-shadcn-template.git
   cd nextjs-shadcn-template
   ```

2. **Install dependencies**

   ```bash
   pnpm install
   # or
   npm install
   ```

3. **Run the development server**

   ```bash
   pnpm dev
   # or
   npm run dev
   ```

4. **Open your browser**

   Visit [http://localhost:3000](http://localhost:3000) to see the result.

## 📂 Project Structure

```
nextjs-shadcn-template/
├── src/
│   ├── app/                  # App Router (Next.js 13+)
│   │   ├── [locale]/        # Internationalized routes
│   │   ├── layout.tsx       # Root layout
│   │   └── globals.css      # Global styles
│   ├── components/          # Reusable components
│   │   ├── ui/             # shadcn/ui components
│   │   ├── demo-card/      # Demo showcase component
│   │   ├── theme-button/   # Theme toggle component
│   │   └── language-selector/ # Language switcher
│   ├── providers/          # Context providers
│   │   ├── store-provider.tsx    # Zustand store provider
│   │   └── theme-provider.tsx    # Theme provider
│   ├── stores/             # Zustand stores
│   │   └── store.ts        # Main app store
│   ├── i18n/              # Internationalization
│   │   ├── routing.ts     # Locale routing config
│   │   └── request.ts     # Request configuration
│   └── lib/               # Utility functions
│       └── utils.ts       # Shared utilities
├── messages/              # Translation files
│   ├── en.json           # English translations
│   └── zh.json           # Chinese translations
└── public/               # Static assets
```

## 🎨 Customization

### Adding New Languages

1. Add the locale to `src/i18n/routing.ts`:

   ```typescript
   locales: ["en", "zh", "your-locale"];
   ```

2. Create translation file `messages/your-locale.json`

3. Update the language selector in `src/components/language-selector/index.tsx`

### Adding New Components

Use shadcn/ui CLI to add components:

```bash
pnpm dlx shadcn@latest add button
# or
npx shadcn@latest add button
```

### Extending Zustand Store

Edit `src/stores/store.ts` to add your state and actions:

```typescript
export type AppState = {
  count: number;
  // Add your state here
};

export type AppActions = {
  incrementCount: () => void;
  // Add your actions here
};
```

## 📦 Available Scripts

- `pnpm dev` - Start development server
- `pnpm build` - Build for production
- `pnpm start` - Start production server
- `pnpm lint` - Run ESLint

## 🌐 Deployment

The easiest way to deploy is using [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js):

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/ldw-templates/nextjs-shadcn-template)

Or deploy to other platforms:

- [Netlify](https://netlify.com)
- [Railway](https://railway.app)
- [Render](https://render.com)

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 👨‍💻 Author

**LIKEDREAMWALKER**

- 🏠 Homepage: [https://ldwid.com](https://ldwid.com)
- 🐙 GitHub: [@LikeDreamwalker](https://github.com/LikeDreamwalker)
- 📁 Templates: [@ldw-templates](https://github.com/ldw-templates)

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Next.js](https://nextjs.org) team for the amazing framework
- [shadcn](https://github.com/shadcn) for the beautiful UI components
- [Vercel](https://vercel.com) for the hosting platform
- All the open-source contributors who made this possible

---

⭐ If you find this template helpful, please consider giving it a star!
