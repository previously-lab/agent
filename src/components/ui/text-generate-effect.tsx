"use client";
import { useEffect } from "react";
import { motion, stagger, useAnimate, useInView } from "motion/react";
import { cn } from "@/lib/utils";

export const TextGenerateEffect = ({
  words,
  className,
  filter = true,
  duration = 0.5,
  delay = 0,
  staggerDelay = 0.2,
  animateOnView = false,
}: {
  words: string;
  className?: string;
  filter?: boolean;
  duration?: number;
  delay?: number;
  /** Seconds between each word appearing. Lower = faster "reading" pace. */
  staggerDelay?: number;
  /** When true, the animation waits until the element scrolls into view. */
  animateOnView?: boolean;
}) => {
  const [scope, animate] = useAnimate();
  const isInView = useInView(scope, { once: true, margin: "0px" });
  const wordsArray = words.split(" ");

  useEffect(() => {
    if (animateOnView && !isInView) return;
    animate(
      "span",
      {
        opacity: 1,
        filter: filter ? "blur(0px)" : "none",
      },
      {
        duration: duration,
        delay: stagger(staggerDelay, { startDelay: delay }),
      }
    );
  }, [scope.current, isInView, words]);

  const renderWords = () => {
    return (
      <motion.div key={words} ref={scope}>
        {wordsArray.map((word, idx) => {
          return (
            <motion.span
              key={word + idx}
              className="opacity-0"
              style={{
                filter: filter ? "blur(10px)" : "none",
              }}
            >
              {word}{" "}
            </motion.span>
          );
        })}
      </motion.div>
    );
  };

  return <div className={cn(className)}>{renderWords()}</div>;
};
