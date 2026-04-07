// Each plot has its own map URL zoomed into its specific parcel area
// bbox: lon_min, lat_min, lon_max, lat_max  |  marker: lat, lon
// treeBatches: [{ year, count }]  — each batch represents trees planted that year
// A parcel can hold trees of multiple different ages

export const projects = [
  {
    id: 'tunis',
    city: 'Tunis',
    region: 'La Marsa',
    title: 'Projet Olivier — La Marsa',
    area: '15 Ha',
    year: 2016,
    mapUrl:
      'https://www.openstreetmap.org/export/embed.html?bbox=10.274,36.839,10.374,36.939&layer=mapnik&marker=36.8892,10.3241',
    plots: [
      {
        id: 101, area: 320, trees: 48, pricePerTree: 1500, totalPrice: 72000,
        mapUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=10.306,36.871,10.346,36.911&layer=mapnik&marker=36.891,10.326',
        treeBatches: [
          { year: 2016, count: 28 },
          { year: 2021, count: 20 },
        ],
      },
      {
        id: 102, area: 350, trees: 53, pricePerTree: 1500, totalPrice: 79500,
        mapUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=10.302,36.868,10.342,36.908&layer=mapnik&marker=36.888,10.322',
        treeBatches: [
          { year: 2015, count: 53 },
        ],
      },
      {
        id: 103, area: 290, trees: 44, pricePerTree: 1400, totalPrice: 61600,
        mapUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=10.300,36.873,10.340,36.913&layer=mapnik&marker=36.893,10.320',
        treeBatches: [
          { year: 2014, count: 20 },
          { year: 2018, count: 15 },
          { year: 2022, count: 9 },
        ],
      },
      {
        id: 104, area: 410, trees: 62, pricePerTree: 1600, totalPrice: 99200,
        mapUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=10.308,36.866,10.348,36.906&layer=mapnik&marker=36.886,10.328',
        treeBatches: [
          { year: 2017, count: 40 },
          { year: 2020, count: 22 },
        ],
      },
      {
        id: 105, area: 380, trees: 57, pricePerTree: 1500, totalPrice: 85500,
        mapUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=10.305,36.875,10.345,36.915&layer=mapnik&marker=36.895,10.325',
        treeBatches: [
          { year: 2019, count: 57 },
        ],
      },
    ],
  },
  {
    id: 'sousse',
    city: 'Sousse',
    region: 'El Kantaoui',
    title: 'Projet Olivier — El Kantaoui',
    area: '25 Ha',
    year: 2015,
    mapUrl:
      'https://www.openstreetmap.org/export/embed.html?bbox=10.550,35.833,10.650,35.933&layer=mapnik&marker=35.8834,10.6004',
    plots: [
      {
        id: 201, area: 500, trees: 75, pricePerTree: 1500, totalPrice: 112500,
        mapUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=10.583,35.866,10.623,35.906&layer=mapnik&marker=35.886,10.603',
        treeBatches: [
          { year: 2015, count: 40 },
          { year: 2020, count: 35 },
        ],
      },
      {
        id: 202, area: 460, trees: 69, pricePerTree: 1500, totalPrice: 103500,
        mapUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=10.578,35.861,10.618,35.901&layer=mapnik&marker=35.881,10.598',
        treeBatches: [
          { year: 2015, count: 25 },
          { year: 2019, count: 25 },
          { year: 2023, count: 19 },
        ],
      },
      {
        id: 203, area: 380, trees: 57, pricePerTree: 1400, totalPrice: 79800,
        mapUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=10.586,35.864,10.626,35.904&layer=mapnik&marker=35.884,10.606',
        treeBatches: [
          { year: 2020, count: 57 },
        ],
      },
      {
        id: 204, area: 420, trees: 63, pricePerTree: 1450, totalPrice: 91350,
        mapUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=10.581,35.859,10.621,35.899&layer=mapnik&marker=35.879,10.601',
        treeBatches: [
          { year: 2017, count: 35 },
          { year: 2021, count: 28 },
        ],
      },
    ],
  },
  {
    id: 'sfax',
    city: 'Sfax',
    region: 'Thyna',
    title: 'Projet Olivier — Thyna',
    area: '40 Ha',
    year: 2016,
    mapUrl:
      'https://www.openstreetmap.org/export/embed.html?bbox=10.710,34.690,10.810,34.790&layer=mapnik&marker=34.7406,10.7603',
    plots: [
      {
        id: 301, area: 600, trees: 90, pricePerTree: 1300, totalPrice: 117000,
        mapUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=10.743,34.723,10.783,34.763&layer=mapnik&marker=34.743,10.763',
        treeBatches: [
          { year: 2016, count: 50 },
          { year: 2023, count: 40 },
        ],
      },
      {
        id: 302, area: 550, trees: 83, pricePerTree: 1300, totalPrice: 107900,
        mapUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=10.738,34.718,10.778,34.758&layer=mapnik&marker=34.738,10.758',
        treeBatches: [
          { year: 2021, count: 83 },
        ],
      },
      {
        id: 303, area: 480, trees: 72, pricePerTree: 1250, totalPrice: 90000,
        mapUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=10.746,34.721,10.786,34.761&layer=mapnik&marker=34.741,10.766',
        treeBatches: [
          { year: 2018, count: 40 },
          { year: 2022, count: 32 },
        ],
      },
      {
        id: 304, area: 520, trees: 78, pricePerTree: 1300, totalPrice: 101400,
        mapUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=10.741,34.716,10.781,34.756&layer=mapnik&marker=34.736,10.761',
        treeBatches: [
          { year: 2016, count: 30 },
          { year: 2019, count: 30 },
          { year: 2023, count: 18 },
        ],
      },
      {
        id: 305, area: 430, trees: 65, pricePerTree: 1200, totalPrice: 78000,
        mapUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=10.736,34.724,10.776,34.764&layer=mapnik&marker=34.744,10.756',
        treeBatches: [
          { year: 2020, count: 65 },
        ],
      },
    ],
  },
  {
    id: 'nabeul',
    city: 'Nabeul',
    region: 'Hammamet',
    title: 'Projet Olivier — Hammamet',
    area: '10 Ha',
    year: 2018,
    mapUrl:
      'https://www.openstreetmap.org/export/embed.html?bbox=10.570,36.340,10.670,36.440&layer=mapnik&marker=36.3947,10.6154',
    plots: [
      {
        id: 401, area: 260, trees: 39, pricePerTree: 1600, totalPrice: 62400,
        mapUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=10.598,36.377,10.638,36.417&layer=mapnik&marker=36.397,10.618',
        treeBatches: [
          { year: 2018, count: 22 },
          { year: 2022, count: 17 },
        ],
      },
      {
        id: 402, area: 300, trees: 45, pricePerTree: 1600, totalPrice: 72000,
        mapUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=10.593,36.372,10.633,36.412&layer=mapnik&marker=36.392,10.613',
        treeBatches: [
          { year: 2019, count: 45 },
        ],
      },
      {
        id: 403, area: 280, trees: 42, pricePerTree: 1550, totalPrice: 65100,
        mapUrl: 'https://www.openstreetmap.org/export/embed.html?bbox=10.601,36.375,10.641,36.415&layer=mapnik&marker=36.395,10.621',
        treeBatches: [
          { year: 2018, count: 25 },
          { year: 2024, count: 17 },
        ],
      },
    ],
  },
]
