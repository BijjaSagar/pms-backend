import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { RequirePermissions } from '../common/decorators/access.decorator.js';
import { db } from '../prisma/db.js';
import { brand, now } from '../prisma/compat.js';
import type { AuthenticatedRequest } from '../common/guards/auth.guard.js';

/**
 * The eight theme keys from the implementation kit. The database enum is the
 * authoritative store, but validating against this allow-list first means an
 * unknown key is rejected as a 400 rather than surfacing as a database error,
 * and arbitrary CSS/colour values can never reach storage.
 */
const THEME_KEYS = [
  'MIDNIGHT_NAVY',
  'SKY_BLUE_WHITE',
  'LUXURY_BEIGE_TAUPE',
  'SAGE_GREEN',
  'SOFT_BLUE_SLATE',
  'EUCALYPTUS',
  'OLIVE_CREAM',
  'DUSTY_LAVENDER',
] as const;

const DEFAULT_THEME = 'LUXURY_BEIGE_TAUPE';

class SetThemeDto {
  @IsIn(THEME_KEYS as unknown as string[], { message: 'Unknown theme key' })
  themeKey!: (typeof THEME_KEYS)[number];
}

@Controller('preferences')
export class PreferencesController {
  @RequirePermissions('theme.update')
  @Get('theme')
  async getTheme(@Req() req: AuthenticatedRequest) {
    const propertyId = req.user!.activePropertyId;
    if (!propertyId) return { themeKey: DEFAULT_THEME };

    const pref = await db.orm.public.UserThemePreference
      .where({ userId: brand(req.user!.id), propertyId: brand(propertyId) })
      .first();
    return { themeKey: pref?.themeKey ?? DEFAULT_THEME };
  }

  @RequirePermissions('theme.update')
  @Put('theme')
  async setTheme(@Body() dto: SetThemeDto, @Req() req: AuthenticatedRequest) {
    const propertyId = req.user!.activePropertyId;
    if (!propertyId) return { themeKey: DEFAULT_THEME, applied: false };

    const existing = await db.orm.public.UserThemePreference
      .where({ userId: brand(req.user!.id), propertyId: brand(propertyId) })
      .first();

    if (existing) {
      await db.orm.public.UserThemePreference
        .where({ id: brand(existing.id) })
        .update({ themeKey: brand(dto.themeKey), updatedAt: now() });
    } else {
      await db.orm.public.UserThemePreference.create({
        userId: brand(req.user!.id),
        propertyId: brand(propertyId),
        themeKey: brand(dto.themeKey),
        updatedAt: now(),
      });
    }
    return { themeKey: dto.themeKey, applied: true };
  }
}