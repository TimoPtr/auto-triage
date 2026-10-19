package io.ha.widgets

import android.content.Context

/**
 * Renders the state of one entity on the home screen.
 */
class EntityWidget(private val context: Context) {
    fun refresh() {
        val label = context.getString(R.string.widget_entity_refresh)
    }
}

/** Shared helper. */
internal fun widgetLabel(context: Context): String = context.getString(commonR.string.widget_label)

private const val TAG = "EntityWidget"
