import base from './playwright.config';
import { devices } from '@playwright/test';
export default { ...base, projects: [{ name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1200, height: 600 } } }] };
