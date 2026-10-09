"use client";

/**
 * The visual lab's root (dev-only — see src/app/[locale]/lab/page.tsx).
 * A vertical list of full-page recipes, each screenshot-able on its own via
 * --selector "[data-recipe='…']". The home replica imports home-paper.css so
 * it tracks the real cover's classes instead of forking them.
 */

import "@/components/home/home-paper.css";
import "./lab.css";
import { LabPageIntro } from "./recipe-chrome";
import { RecipePile, RecipePileScene } from "./recipe-pile";
import {
  RecipeGrid,
  RecipeGridMobile,
  RecipeGridScene,
} from "./recipe-grid";
import { RecipePaper } from "./recipe-paper";
import { RecipeCover } from "./recipe-cover";
import { RecipeRoom } from "./recipe-room";
import { RecipeTransition } from "./recipe-transition";

export function LabPage() {
  return (
    <main className="lab-root">
      <LabPageIntro />
      <RecipePile />
      <RecipePileScene />
      <RecipeGrid />
      <RecipeGridMobile />
      <RecipeGridScene />
      <RecipePaper />
      <RecipeCover />
      <RecipeRoom />
      <RecipeTransition />
    </main>
  );
}
