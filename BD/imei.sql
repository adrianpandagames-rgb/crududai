DROP TABLE IF EXISTS `imei`;
DROP TABLE IF EXISTS `objetivoImei`;

CREATE TABLE `objetivoImei` (
  `idObjetivo` INT NOT NULL AUTO_INCREMENT,
  `numObjetivo` VARCHAR(100) NOT NULL,
  `nuc` VARCHAR(20) NOT NULL,
  `tipo` VARCHAR(50) NOT NULL,
  `ano` YEAR NOT NULL,
  PRIMARY KEY (`idObjetivo`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `imei` (
  `idImei` INT NOT NULL AUTO_INCREMENT,
  `imei` VARCHAR(255) NOT NULL,
  `idObjetivo` INT NOT NULL,
  `brand_name` VARCHAR(255) NULL,
  `modelo` VARCHAR(255) NULL,
  `metadata_check_count` INT NOT NULL DEFAULT 0,
  `metadata_not_found` TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`idImei`),
  FOREIGN KEY (`idObjetivo`) REFERENCES `objetivoImei`(`idObjetivo`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
