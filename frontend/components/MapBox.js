/* eslint-disable react-hooks/exhaustive-deps */
import React, {useEffect, useRef, useState} from 'react';
import {Box, Text, useBase, useRecords} from '@airtable/blocks/ui';

import mapboxgl from 'mapbox-gl';

// Lib functions
import findPoint from '../lib/findPoint';
import debounce from '../lib/debounce';
import {polygonEditor} from "../lib/polygonEditor";

// Custom Hooks
import {useSettings} from "../hooks/settings";

// Components
import {RasterOpacityControl} from "./RasterOpacityControl";

// Map functions
import addClustering from '../map/addClustering';
import {addHover, setHoverFillOpacity} from "../map/addHover";
import {removeImageSources, updateImageSources} from "../map/addImagesSources";
import {addPlacesLayers, setPlacesFillOpacity} from "../map/addPlacesLayers";
import addSources from "../map/addSources";
import zoomSelected from '../map/zoomSelected';
import {getRecordsById} from "../lib/getRecordsById";

let mapType = '';

export function MapBox({
                         // properties
                         activeTable,
                         activeView,
                         editMode,
                         map,
                         records,
                         allRecords,
                         selectedRecordIds,
                         showBackgrounds,
                         showColors,

                         // functions
                         selectRecord,
                         setJsonErrorRecords,
                         setMap,
                       }) {
  const mapContainerRef = useRef(null);

  const [features, setFeatures] = useState([]);
  const [initialized, setInitialized] = useState(false);
  const [lng, setLng] = useState(-100);
  const [lat, setLat] = useState(38);
  const [zoom, setZoom] = useState(1);

  const {settings} = useSettings();
  const geometryField = settings.geometryField;
  const labelField = settings.labelField && activeTable.getFieldByNameIfExists(settings.labelField) ? settings.labelField : activeTable.primaryField;
  mapboxgl.accessToken = settings.mapboxAccessToken;

  function parseFeatures() {
    const jsonErrorRecords = [];
    const selectedIds = selectedRecordIds.length === 1 && editMode ? selectedRecordIds : [];
    const filteredRecordIds = records.map(r => r.id);
    const newFeatures = allRecords.filter(record => record.getCellValue(geometryField)).map(record => {
      try {
        const source = {
          type: 'Feature',
          geometry: JSON.parse(record.getCellValueAsString(geometryField) || null),
          id: record.id,
          properties: {
            id: record.id,
            name: isSwitched('labels-switch')
                ? record.getCellValueAsString(labelField)
                : "",
            selected: selectedRecordIds.includes(record.id),
            invisible: selectedIds.includes(record.id),
          }
        };

        source.properties.labelPoint = findPoint(source);

        if (showColors) {
          try {
            const color = record.getColorHexInView(activeView);
            if (color) {
              source.properties.color = color;
            }
          } catch (e) {
            // Silently fail to use default layer color
          }
        }

        if (!filteredRecordIds.includes(source.id)) {
          source.properties.color = '#878787';
        }

        return source;
      } catch (e) {
        jsonErrorRecords.push(record.id);
        return null;
      }
    }).filter(r => r !== null);

    if (JSON.stringify(newFeatures) !== JSON.stringify(features)) {
      setFeatures(newFeatures);
    }

    setJsonErrorRecords(jsonErrorRecords);
  }

  function addEvents(map) {
    map.on('click', 'places-fill', function (e) {
      // Check if click is on top of a new shape.
      const isNewShape = polygonEditor.isActive(map) && map.queryRenderedFeatures(e.point)
          .some(feature => feature.source.substring(0, 15) === 'mapbox-gl-draw-');

      // Prevent changing records while drawing a new shape or clicking on a new shape.
      if (!polygonEditor.isDrawing() && !isNewShape) {
        selectRecord(e.features[0].properties.id);
      }

      // When a click event occurs on a feature in the places layer, open a popup at the
      // location of the click, with description HTML from its properties.
      // Popup Tooltip
      // new mapboxgl.Popup()
      // .setLngLat(e.lngLat)
      // .setHTML(e.features[0].properties.name)
      // .addTo(map);
    });

    map.on('click', function (e) {
      const features = map.queryRenderedFeatures(e.point, {layers: ['places-fill']});
      const isActive = polygonEditor.isActive(map);
      const isDrawing = polygonEditor.isDrawing();

      if (!isDrawing && !isActive && features.length === 0) {
        selectRecord();
      }
    });

    const labelsDebounce = debounce(() => updateMapPolygons(map), 500);
    map.on('sourcedata', (e) => {
      if (e.sourceId === 'labels') {
        labelsDebounce();
      }
    });
    map.on('zoomend', labelsDebounce);
    map.on('moveend', labelsDebounce);

    // Add Map to state
    setMap(map);

    // Update FeatureCollection data
    updateMap();
  }

  const labels = features.map(feature => {
    return {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: feature.properties.labelPoint
      },
      properties: {
        id: feature.properties.id,
        name: feature.properties.name,
        original: feature,
        selected: feature.properties.selected,
      }
    };
  });

  useEffect(() => {
    if (initialized) {
      tryZooming(initialized);

      if (selectedRecordIds.length === 1 && editMode) {
        try {
          polygonEditor.toggle(map, true);
          const record = records.find(r => r.id === selectedRecordIds[0]);
          const feature = {
            id: Date.now(),
            type: 'Feature',
            properties: {},
            geometry: JSON.parse(record.getCellValueAsString(geometryField) || null)
          };
          if (feature.geometry) {
            polygonEditor.add(feature);
          }
        } catch (e) {
          // Most likely bad JSON
          polygonEditor.toggle(map, false);
        }
      } else {
        polygonEditor.toggle(map, false);
      }
    }
  }, [editMode, selectedRecordIds]);

  useEffect(() => {
    if (initialized) {
      setInitialized(false);
    }
  }, [activeView]);

  useEffect(() => {
    parseFeatures();
  }, [editMode, records, selectedRecordIds]);

  useEffect(() => {
    if (map && activeTable) {
      setPlacesFillOpacity(map, activeTable.id !== settings.images.table);
      setHoverFillOpacity(map, activeTable.id !== settings.images.table);
    }
  }, [activeTable, map, settings.images.table]);

  // Initialize map when component mounts
  useEffect(() => {
    document.getElementById("histogenes-radio").checked = true;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/outdoors-v11',
      center: [lng, lat],
      zoom: zoom
    });

    const mapRadios = document.getElementsByName('map-radio');
    for (let i = 0; i < mapRadios.length; i++) {
      mapRadios[i].addEventListener('change', changeSwitched);
    }

    const outdoorMap = document.getElementById('outdoor-radio');
    outdoorMap.onclick = function() {
      map.setLayoutProperty('white-map', 'visibility', 'none');
      setTerrainWithRomanRoads(map, 'none');
      setStructureLabels(map, 'none');
    }

    const histogenesMap = document.getElementById('histogenes-radio');
    histogenesMap.onclick = function() {
      map.setLayoutProperty('white-map', 'visibility', 'none');
      setStructureLabels(map, 'none');
      setTerrainWithRomanRoads(map, 'visible')
    }

    const structuresMap = document.getElementById('structures-radio');
    structuresMap.onclick = function() {
      setStructureLabels(map,'visible');
      map.setLayoutProperty('white-map', 'visibility', 'none');
      setTerrainWithRomanRoads(map, 'visible')
    }

    const whiteBackground = document.getElementById('white-radio');
    whiteBackground.onclick = function() {
      setStructureLabels(map, 'none');
      setTerrainWithRomanRoads(map, 'none');
      map.setLayoutProperty('white-map', 'visibility', 'visible');
    }

    // Map controls
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    map.on('move', () => {
      setLng(+(map.getCenter().lng.toFixed(4)));
      setLat(+(map.getCenter().lat.toFixed(4)));
      setZoom(+(map.getZoom().toFixed(2)));
    });

    polygonEditor.init(map);

    map.on('style.load', function () {
      addSources(map);
      addTerrainWithRomanRoadsLayers(map);
      setTerrainWithRomanRoads(map, 'visible');
    });

    // Draw polygons
    map.on('load', function () {
      addLayers(map);
      addStructures(map);
      addEvents(map);
    });

    // Clean up on unmount
    return () => {
      map.remove();
      setMap(null);
    };
  }, []);

  function updateMapPolygons(map) {
    try {
      const features = map.querySourceFeatures('labels', {sourceLayer: 'labels-text'})
          .filter(feature => !feature.id)
          .filter((v, i, a) => a.findIndex(t => t.properties.id === v.properties.id) === i) //Attila: this is to remove duplicates
          .map(f => JSON.parse(f.properties.original));
      map.getSource('places').setData({
        type: 'FeatureCollection',
        features
      });
    } catch (e) {
      // Catch the odd disappearing map
    }
  }

  // Update FeatureCollection data
  function updateMap() {
    if (map) {
      const labelsSource = map.getSource('labels');
      labelsSource.setData({
        type: 'FeatureCollection',
        features: labels
      });

      if (!initialized) {
        tryZooming(initialized);
        setInitialized(true);
      }
    }
  }

  function tryZooming(initialized) {
    if (features.length === 0 || editMode) {
      return;
    }

    if (selectedRecordIds.length > 0) {
      // If all selected records don't have any geometry, don't zoom
      const nonemptyGeometryRecords = getRecordsById(records, selectedRecordIds)
          .filter(record => record.getCellValue(geometryField));
      if (nonemptyGeometryRecords.length === 0) {
        return;
      }
    }

    //Attila: if nothing selected (remove selection), do not zoom out. Zoom when map first initialised
    if (!initialized || selectedRecordIds.length > 0) {
      zoomSelected(map, selectedRecordIds, features)
    }
  }

  // Observe features for record changes
  useEffect(() => {
    updateMap();
  }, [features, map]);

  return (
      <>
        <Box
            display="none"
            position="absolute"
            top={0}
            left={0}
            zIndex="5"
            margin={2}
            padding={2}
            backgroundColor="grayDark1">
          <Text textColor="white">
            Longitude: {lng} | Latitude: {lat} | Zoom: {zoom}
          </Text>
        </Box>
        {showBackgrounds && <RasterOpacityControl map={map}/>}
        <div
            className="map-container"
            ref={mapContainerRef}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              right: 0,
            }}/>
        {settings.images.table && initialized && (
            <ImageSourceRecords activeTable={activeTable} map={map} settings={settings.images} show={showBackgrounds} type={mapType}/>
        )}
      </>
  );
}

function isSwitched(switchId) {
  const switchElement = document.getElementById(switchId);
  return switchElement
          ? switchElement.getAttribute('aria-checked') === 'true'
          : false;
}

function changeSwitched() {
  mapType = this.value;
}

function setStructureLabels(map, visibility) {
  map.setLayoutProperty('admin_str', 'visibility', visibility);
  map.setLayoutProperty('aeroway_str', 'visibility', visibility);
  map.setLayoutProperty('building_str', 'visibility', visibility);
  map.setLayoutProperty('road_str', 'visibility', visibility);
}

function setTerrainWithRomanRoads(map, visibility) {
  map.setLayoutProperty('background', 'visibility', visibility);
  map.setLayoutProperty('mapbox-terrain-rgb', 'visibility', visibility);
  map.setLayoutProperty('hillshade-1', 'visibility', visibility);
  map.setLayoutProperty('water-1', 'visibility', visibility);
  map.setLayoutProperty('roman-roads-12ig1q', 'visibility', visibility);
}

function addLayers(map) {
  addWhiteLayer(map);
  addPlacesLayers(map);

  map.addLayer({
    'id': 'labels-text',
    'type': 'symbol',
    'source': 'labels',
    'layout': {
      'text-field': ['get', 'name'],
      'text-variable-anchor': ['center'],
      'text-justify': 'auto',
      'text-allow-overlap': true,
      'text-size': 14,
    },
    'filter': ['!', ['has', 'point_count']],
  });
  addClustering(map);
  // Adds additional fill layer and events
  addHover(map);
}

function addWhiteLayer(map) {
  map.addLayer({
    'id': 'white-map',
    'type': 'background',
    'paint': {
      'background-color': 'white'
    },
    'layout': {
      'visibility': 'none'
    }
  });
}

function addTerrainWithRomanRoadsLayers(map) {
  map.addLayer({
    'id': 'background',
    'type': 'background',
    'paint': {
      "background-color": "hsl(172, 1%, 88%)"
    },
    'layout': {
      'visibility': 'none'
    }
  });
  map.addLayer({
    "id": "mapbox-terrain-rgb",
    "type": "fill",
    "source": "composite",
    "source-layer": "hillshade",
    "maxzoom": 16,
    'layout': {
      'visibility': 'none'
    },
    "paint": {
      "fill-color": [
        "match",
        ["get", "class"],
        "shadow",
        "hsl(203, 0%, 14%)",
        "hsl(203, 0%, 19%)"
      ],
      "fill-opacity": [
        "interpolate",
        ["linear"],
        ["zoom"],
        14,
        ["match",
          ["get", "level"],
          [67, 56],
          0.06,
          [89, 78],
          0.03, 0.04
        ],
        16, 0
      ],
      "fill-antialias": false
    }
  });
  map.addLayer({
    'id': 'hillshade-1',
    'type': 'fill',
    "paint": {
      "fill-opacity": 0.08,
      "fill-color": "hsla(0, 0%, 0%, 0.02)"
    },
    'layout': {
      'visibility': 'none'
    },
    "source": "composite-1",
    "source-layer": "hillshade",
    "metadata": {
      "mapbox:group": "cab8558e3cdf86aa1b63faf70cb4fe96"
    }
  });
  map.addLayer({
    'id': 'water-1',
    'type': 'fill',
    'paint': {
      'fill-color': "hsla(196, 65%, 28%, 0.65)",
      'fill-translate': [0, 0],
      'fill-outline-color': "hsl(0, 3%, 43%)"
    },
    'layout': {
      'visibility': 'none'
    },
    'source': 'composite-1',
    'source-layer': 'water'
  });
  map.addLayer({
    'id': 'roman-roads-12ig1q',
    'type': 'line',
    "paint": {
      "line-color": "hsl(0, 78%, 49%)",
      "line-width": 0.4
    },
    'layout': {
      'visibility': 'none'
    },
    "source": "composite-1",
    "source-layer": "Roman_Roads-12ig1q"
  });
}

function addStructures(map) {
  map.addLayer({
    'id': 'admin_str',
    'source': 'mapbox-streets',
    'source-layer': 'admin',
    'type': 'line',
    "filter": ["==", ["get", "admin_level"], 0],
    'paint': {
      'line-color': 'rgba(255, 187, 0, 1)',
      'line-width': 2
    },
    'layout': {
      'visibility': 'none'
    }
  });

  map.addLayer({
    "id": "aeroway_str",
    "source": "mapbox-streets",
    "source-layer": "aeroway",
    "type": "line",
    "paint": {
      "line-color": "#ffffff"
    },
    'layout': {
      'visibility': 'none'
    }
  });

  map.addLayer({
    "id": "building_str",
    "source": "mapbox-streets",
    "source-layer": "building",
    "type": "fill",
    'layout': {
      'visibility': 'none'
    }
  });

  map.addLayer({
    "id": "road_str",
    "source": "mapbox-streets",
    "source-layer": "road",
    "type": "line",
    "paint": {
      "line-color": "#ffffff"
    },
    'layout': {
      'visibility': 'none'
    }
  });
}

function ImageSourceRecords({map, settings, show, type}) {
  const [sourceRecords, setSourceRecords] = useState([]);
  const base = useBase();
  const table = base.getTableById(settings.table);
  const records = useRecords(table);

  useEffect(() => {
    if (
      JSON.stringify(sourceRecords.map(r => r.toString())) !==
      JSON.stringify(records.map(r => r.toString()))
    ) {
      setSourceRecords(records);
    }
  }, [records]);

  useEffect(() => {
    if (show) {
      updateImageSources(map, records, settings);
    } else {
      removeImageSources(map);
    }
  }, [type, show, sourceRecords]);

  return (<></>);
}
