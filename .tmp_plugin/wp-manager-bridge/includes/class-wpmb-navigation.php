<?php
defined( 'ABSPATH' ) || exit;

/**
 * WPMB_Navigation — Menu management endpoints.
 */
class WPMB_Navigation {

    public static function register_routes() {
        $ns = WPMB_NAMESPACE;
        $ep = [ 'WPMB_Auth', 'require_editor' ];

        register_rest_route( $ns, '/navigation', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'get_navigation' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/navigation/sync', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'sync_navigation' ],
            'permission_callback' => $ep,
        ] );
    }

    public static function get_navigation(): WP_REST_Response {
        $nav_menus = wp_get_nav_menus();
        $result    = [];

        foreach ( $nav_menus as $menu ) {
            $items     = wp_get_nav_menu_items( $menu->term_id );
            $item_data = [];

            if ( $items ) {
                foreach ( $items as $item ) {
                    $item_data[] = [
                        'id'        => $item->ID,
                        'title'     => $item->title,
                        'url'       => $item->url,
                        'parent'    => (int) $item->menu_item_parent,
                        'order'     => (int) $item->menu_order,
                        'target'    => $item->target,
                        'type'      => $item->type,
                        'object_id' => (int) $item->object_id,
                    ];
                }
            }

            $result[] = [
                'id'    => $menu->term_id,
                'name'  => $menu->name,
                'slug'  => $menu->slug,
                'count' => $menu->count,
                'items' => $item_data,
            ];
        }

        $locations         = get_nav_menu_locations();
        $registered_locs   = get_registered_nav_menus();

        return new WP_REST_Response( [
            'menus'              => $result,
            'locations'          => $locations,
            'registered_locations' => $registered_locs,
        ], 200 );
    }

    public static function sync_navigation( WP_REST_Request $request ): WP_REST_Response {
        $menus    = (array) ( $request->get_param( 'menus' ) ?? [] );
        $updated  = 0;

        foreach ( $menus as $menu_data ) {
            $menu_id = (int) ( $menu_data['id'] ?? 0 );
            if ( ! $menu_id ) continue;

            foreach ( (array) ( $menu_data['items'] ?? [] ) as $item ) {
                $item_id = (int) ( $item['id'] ?? 0 );
                if ( ! $item_id ) continue;

                wp_update_nav_menu_item( $menu_id, $item_id, [
                    'menu-item-title'    => sanitize_text_field( $item['title'] ?? '' ),
                    'menu-item-url'      => esc_url_raw( $item['url'] ?? '' ),
                    'menu-item-status'   => 'publish',
                    'menu-item-position' => (int) ( $item['order'] ?? 0 ),
                    'menu-item-parent-id'=> (int) ( $item['parent'] ?? 0 ),
                ] );
                $updated++;
            }
        }

        return new WP_REST_Response( [ 'success' => true, 'updated_items' => $updated ], 200 );
    }
}
