#!/bin/bash
# Only trigger Vercel deployment when commit message contains [deploy]
git log -1 --pretty=%B | grep -q '\[deploy\]'
