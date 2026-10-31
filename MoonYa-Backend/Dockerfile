# Build with the generated PHP bundle as context, never the desktop installation.
FROM php:8.2-apache
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg poppler-utils libfreetype6-dev libjpeg62-turbo-dev libpng-dev libwebp-dev libonig-dev libzip-dev \
    && docker-php-ext-configure gd --with-freetype --with-jpeg --with-webp \
    && docker-php-ext-install -j$(nproc) gd pdo_mysql mysqli mbstring zip \
    && a2enmod rewrite headers \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
WORKDIR /var/www/html
COPY . /var/www/html/
RUN test ! -d script/MoonYa-index \
    && composer install --no-dev --optimize-autoloader \
    && mkdir -p /var/lib/moonya uploads/avatars \
    && chown -R www-data:www-data /var/lib/moonya uploads
COPY deployment/apache.conf /etc/apache2/conf-enabled/moonya.conf
ENV MOONYA_SERVER_DATA_ROOT=/var/lib/moonya
EXPOSE 80
