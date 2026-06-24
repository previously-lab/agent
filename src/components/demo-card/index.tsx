"use client";

import { useTranslations } from "next-intl";
import { useAppStore } from "@/providers/store-provider";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { ThemeButton } from "@/components/theme-button";
import { LanguageSelector } from "@/components/language-selector";
import {
  Minus,
  Plus,
  ExternalLink,
  Home,
  Palette,
  Globe,
  Database,
  Component,
  FileCode2,
  Wind,
} from "lucide-react";

const featureIcons = [
  { key: "theming" as const, icon: Palette },
  { key: "i18n" as const, icon: Globe },
  { key: "state" as const, icon: Database },
  { key: "ui" as const, icon: Component },
  { key: "typescript" as const, icon: FileCode2 },
  { key: "tailwind" as const, icon: Wind },
];

export function DemoCard() {
  const t = useTranslations("HomePage");
  const { count, incrementCount, decrementCount } = useAppStore(
    (state) => state,
  );

  return (
    <div className="flex min-h-svh flex-col items-center justify-center px-4 py-16 sm:px-6 lg:px-8">
      <div className="w-full max-w-5xl space-y-10">
        {/* Header */}
        <div className="space-y-4 text-center">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
            {t("title")}
          </h1>
          <p className="text-lg text-muted-foreground sm:text-xl">
            {t("subtitle")}
          </p>
          <p className="mx-auto max-w-2xl text-sm text-muted-foreground sm:text-base">
            {t("description")}
          </p>
          <div className="flex items-center justify-center gap-2 pt-2">
            <ThemeButton />
            <LanguageSelector />
          </div>
        </div>

        {/* Cards Grid */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* Features Card - full width */}
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>{t("features.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {featureIcons.map(({ key, icon: Icon }) => (
                  <div
                    key={key}
                    className="flex items-center gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-muted/50"
                  >
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Icon className="size-4" />
                    </div>
                    <span>{t(`features.${key}`)}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Zustand Demo Card */}
          <Card>
            <CardHeader>
              <CardTitle>{t("demo.title")}</CardTitle>
              <CardDescription>{t("demo.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col items-center gap-6">
                <div className="flex items-center gap-6">
                  <Button onClick={decrementCount} variant="outline" size="icon">
                    <Minus />
                  </Button>
                  <span className="w-16 text-center text-5xl font-bold tabular-nums">
                    {count}
                  </span>
                  <Button onClick={incrementCount} size="icon">
                    <Plus />
                  </Button>
                </div>
                <p className="text-center text-xs text-muted-foreground">
                  This counter demonstrates Zustand state management with proper
                  SSR support and per-request store isolation.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Creator Card */}
          <Card className="h-full">
            <CardHeader>
              <CardTitle>{t("creator.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="3180.28"
                height="310"
                viewBox="0 0 3180.28 310"
                className="h-6 w-auto text-[#0066ff]"
                fill="currentColor"
              >
                <defs></defs>
                <path
                  id="矩形_1_拷贝_3"
                  data-name="矩形 1 拷贝 3"
                  className="cls-1"
                  d="M2901.21,3469.4H3043.7l8.81-42.3H2958.5l35.25-166.29h-48.18Zm165.11,0h48.18l44.36-208.59h-48.18Zm88.13,0h48.18l12.93-61.4,24.09-22.62,35.84,84.02h55.23l-53.76-115.45,93.13-93.14h-54.05l-88.14,89.9,19.09-89.9h-48.18Zm191.85,0h139.84l8.81-42.3h-91.37l9.41-44.36h76.09l8.52-39.08h-76.09l8.52-40.54h88.72l9.11-42.31h-137.2Zm264.99,0q30.255,0,52.59-12.92a87.065,87.065,0,0,0,34.38-36.43q12.03-23.505,12.04-55.23,0-28.8-11.02-52.45a87.51,87.51,0,0,0-32.9-37.6q-21.885-13.95-55.09-13.96h-69.33V3469.4h69.33Zm74.48-58.31a75.706,75.706,0,0,1-28.35,32.76q-18.81,12.045-46.13,12.04h-54.35V3274.33h54.35q27.03,0,45.69,11.6a75.4,75.4,0,0,1,28.5,32.17q9.84,20.565,9.84,46.72Q3695.32,3390.38,3685.77,3411.09Zm80.64,58.31v-78.73h67.58l50.53,78.73h17.33l-52-81.08a50.48,50.48,0,0,0,25.71-11.17,62.543,62.543,0,0,0,17.18-22.62,69.039,69.039,0,0,0,6.17-29.08,63.261,63.261,0,0,0-4.55-23.51,71.635,71.635,0,0,0-12.63-20.71,62.838,62.838,0,0,0-19.1-14.83,53.493,53.493,0,0,0-24.53-5.59h-86.67V3469.4h14.98Zm0-195.07h71.1a40.19,40.19,0,0,1,23.36,7.2,53.53,53.53,0,0,1,16.74,18.8,51.737,51.737,0,0,1,6.32,25.12,58.672,58.672,0,0,1-5.44,24.97,48.47,48.47,0,0,1-15.42,19.1,38.643,38.643,0,0,1-23.5,7.34h-73.16V3274.33Zm190.67,181.56v-86.67h106.06V3356.3H3957.08v-81.97h121.34v-13.52H3942.1V3469.4h138.96v-13.51H3957.08Zm141.61,13.51h16.15l28.54-68.74h100.8l28.43,68.74h15.86l-88.13-208.59h-12.93Zm49.82-81.08,45.36-109.29,45.2,109.29h-90.56Zm375.58,81.08V3260.81h-14.98l-86.96,149.25-86.97-149.25H4320.2V3469.4h14.98V3289.9l81.97,140.43h9.99l81.97-140.43v179.5h14.98Zm171.28-119.27-43.19,101.65-80.2-190.97h-16.16l89.02,208.59h13.8l46.13-107.23,45.83,107.23h13.81l89.31-208.59h-16.45l-79.91,190.97-43.78-101.65,36.73-87.85h-14.69l-31.14,75.8-31.15-75.8h-14.69Zm166.58,119.27h16.15l28.54-68.74h100.8l28.43,68.74h15.86l-88.13-208.59h-12.93Zm49.82-81.08,45.36-109.29,45.2,109.29h-90.56Zm311.24,81.08v-13.51H5098.44V3260.81h-14.98V3469.4h139.55Zm46.12,0v-64.34l42.31-43.48,83.73,107.82h17.33l-91.07-117.22,86.67-91.37h-17.34l-121.63,126.63V3260.81h-14.98V3469.4h14.98Zm186.56-13.51v-86.67h106.06V3356.3H5455.69v-81.97h121.33v-13.52H5440.71V3469.4h138.96v-13.51H5455.69Zm179.8,13.51v-78.73h67.57l50.53,78.73h17.34l-52-81.08a50.411,50.411,0,0,0,25.7-11.17,62.457,62.457,0,0,0,17.19-22.62,69.192,69.192,0,0,0,6.17-29.08,63.073,63.073,0,0,0-4.56-23.51,71.2,71.2,0,0,0-12.63-20.71,62.718,62.718,0,0,0-19.1-14.83,53.493,53.493,0,0,0-24.53-5.59h-86.66V3469.4h14.98Zm0-195.07h71.1a40.159,40.159,0,0,1,23.35,7.2,53.654,53.654,0,0,1,16.75,18.8,51.728,51.728,0,0,1,6.31,25.12,58.812,58.812,0,0,1-5.43,24.97,48.643,48.643,0,0,1-15.42,19.1,38.673,38.673,0,0,1-23.51,7.34h-73.15V3274.33Zm-2958.52-51.67,223.07-11.65-200.38,61.15Zm54.39,249.55-56.78-245.44,94.61,209.86Zm82.38,37.71L2590.66,3521l200.49-60.64Zm-53.9-249.69,56.3,245.59-94.2-210.11Z"
                  transform="translate(-2590.66 -3211)"
                ></path>
              </svg>
              <p className="mt-3 text-sm text-muted-foreground">
                {t("creator.name")} · {t("creator.role")}
              </p>
            </CardContent>
            <CardFooter className="mt-auto">
              <div className="flex flex-wrap gap-2">
                <a
                    href="https://ldwid.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <Home />
                    {t("creator.homepage")}
                    <ExternalLink />
                  </a>
                  <a
                    href="https://github.com/LikeDreamwalker"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <svg viewBox="0 0 24 24" className="size-4" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>
                    {t("creator.github")}
                    <ExternalLink />
                  </a>
                  <a
                    href="https://github.com/ldw-templates/nextjs-shadcn-template"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <svg viewBox="0 0 24 24" className="size-4" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>
                    {t("creator.repository")}
                    <ExternalLink />
                  </a>
              </div>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}
