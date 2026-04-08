// Each plot has its own map URL zoomed into its specific parcel area
// treeBatches: [{ year, count }]  — each batch represents trees planted that year
// A parcel can hold trees of multiple different ages
// mapUrl: satellite embeds via googleMapsEmbed, or Google My Maps via googleMyMapsEmbed (see mapUrls.js)

import { googleMapsEmbed, googleMyMapsEmbed } from './mapUrls.js'

export const projects = [
  {
    id: 'tunis',
    city: 'Tunis',
    region: 'La Marsa',
    title: 'Projet Olivier — La Marsa',
    area: '15 Ha',
    year: 2016,
    mapUrl: googleMapsEmbed(36.8892, 10.3241, 14),
    plots: [
      {
        id: 101, area: 320, trees: 48, pricePerTree: 1500, totalPrice: 72000,
        mapUrl: googleMyMapsEmbed('1QQeiYeQCN-_ANhvS_Czh-N-KyvS-WB4'),
        treeBatches: [
          { year: 2016, count: 28 },
          { year: 2021, count: 20 },
        ],
      },
      {
        id: 102, area: 350, trees: 53, pricePerTree: 1500, totalPrice: 79500,
        mapUrl: googleMapsEmbed(36.888, 10.322, 17),
        treeBatches: [
          { year: 2015, count: 53 },
        ],
      },
      {
        id: 103, area: 290, trees: 44, pricePerTree: 1400, totalPrice: 61600,
        mapUrl: googleMapsEmbed(36.893, 10.32, 17),
        treeBatches: [
          { year: 2014, count: 20 },
          { year: 2018, count: 15 },
          { year: 2022, count: 9 },
        ],
      },
      {
        id: 104, area: 410, trees: 62, pricePerTree: 1600, totalPrice: 99200,
        mapUrl: googleMapsEmbed(36.886, 10.328, 17),
        treeBatches: [
          { year: 2017, count: 40 },
          { year: 2020, count: 22 },
        ],
      },
      {
        id: 105, area: 380, trees: 57, pricePerTree: 1500, totalPrice: 85500,
        mapUrl: googleMapsEmbed(36.895, 10.325, 17),
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
    mapUrl: googleMapsEmbed(35.8834, 10.6004, 14),
    plots: [
      {
        id: 201, area: 500, trees: 75, pricePerTree: 1500, totalPrice: 112500,
        mapUrl: googleMapsEmbed(35.886, 10.603, 17),
        treeBatches: [
          { year: 2015, count: 40 },
          { year: 2020, count: 35 },
        ],
      },
      {
        id: 202, area: 460, trees: 69, pricePerTree: 1500, totalPrice: 103500,
        mapUrl: googleMapsEmbed(35.881, 10.598, 17),
        treeBatches: [
          { year: 2015, count: 25 },
          { year: 2019, count: 25 },
          { year: 2023, count: 19 },
        ],
      },
      {
        id: 203, area: 380, trees: 57, pricePerTree: 1400, totalPrice: 79800,
        mapUrl: googleMapsEmbed(35.884, 10.606, 17),
        treeBatches: [
          { year: 2020, count: 57 },
        ],
      },
      {
        id: 204, area: 420, trees: 63, pricePerTree: 1450, totalPrice: 91350,
        mapUrl: googleMapsEmbed(35.879, 10.601, 17),
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
    mapUrl: googleMapsEmbed(34.7406, 10.7603, 14),
    plots: [
      {
        id: 301, area: 600, trees: 90, pricePerTree: 1300, totalPrice: 117000,
        mapUrl: googleMapsEmbed(34.743, 10.763, 17),
        treeBatches: [
          { year: 2016, count: 50 },
          { year: 2023, count: 40 },
        ],
      },
      {
        id: 302, area: 550, trees: 83, pricePerTree: 1300, totalPrice: 107900,
        mapUrl: googleMapsEmbed(34.738, 10.758, 17),
        treeBatches: [
          { year: 2021, count: 83 },
        ],
      },
      {
        id: 303, area: 480, trees: 72, pricePerTree: 1250, totalPrice: 90000,
        mapUrl: googleMapsEmbed(34.741, 10.766, 17),
        treeBatches: [
          { year: 2018, count: 40 },
          { year: 2022, count: 32 },
        ],
      },
      {
        id: 304, area: 520, trees: 78, pricePerTree: 1300, totalPrice: 101400,
        mapUrl: googleMapsEmbed(34.736, 10.761, 17),
        treeBatches: [
          { year: 2016, count: 30 },
          { year: 2019, count: 30 },
          { year: 2023, count: 18 },
        ],
      },
      {
        id: 305, area: 430, trees: 65, pricePerTree: 1200, totalPrice: 78000,
        mapUrl: googleMapsEmbed(34.744, 10.756, 17),
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
    mapUrl: googleMapsEmbed(36.3947, 10.6154, 14),
    plots: [
      {
        id: 401, area: 260, trees: 39, pricePerTree: 1600, totalPrice: 62400,
        mapUrl: googleMapsEmbed(36.397, 10.618, 17),
        treeBatches: [
          { year: 2018, count: 22 },
          { year: 2022, count: 17 },
        ],
      },
      {
        id: 402, area: 300, trees: 45, pricePerTree: 1600, totalPrice: 72000,
        mapUrl: googleMapsEmbed(36.392, 10.613, 17),
        treeBatches: [
          { year: 2019, count: 45 },
        ],
      },
      {
        id: 403, area: 280, trees: 42, pricePerTree: 1550, totalPrice: 65100,
        mapUrl: googleMapsEmbed(36.395, 10.621, 17),
        treeBatches: [
          { year: 2018, count: 25 },
          { year: 2024, count: 17 },
        ],
      },
    ],
  },
]
