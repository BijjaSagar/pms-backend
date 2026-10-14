import { Module } from '@nestjs/common';
import { PropertiesController } from './properties.controller.js';
import { InventoryController } from '../rooms/inventory.controller.js';
import { PreferencesController } from '../preferences/preferences.controller.js';

/** Phase 3 backend slice: property configuration, inventory and theme prefs. */
@Module({
  controllers: [PropertiesController, InventoryController, PreferencesController],
})
export class PropertyModule {}